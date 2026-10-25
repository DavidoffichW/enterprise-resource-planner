import { strFromU8, Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import readExcelFile from 'read-excel-file/browser';
import writeExcelFile, { type Cell, type Sheet, type SheetData } from 'write-excel-file/browser';
import {
  SEMANTIC_ROLE_DEFINITIONS,
  type CellScalar,
  type PlanningCell,
  type PlanningDataset,
  type SourceCellInput,
  type SourceProvenance,
  type WorkbookState,
} from '../../contracts';
import {
  canonicalDigest,
  createDatasetFromTable,
  markWorkbookPersisted,
  sha256Hex,
  stableHash,
  stampDatasetRevisions,
  stampWorkbookRevisions,
  validateDataset,
} from '../../core';

export const IMPORT_LIMITS = {
  compressedBytes: 10 * 1024 * 1024,
  uncompressedBytes: 64 * 1024 * 1024,
  memberBytes: 32 * 1024 * 1024,
  entries: 20_000,
  sheets: 20,
  rowsPerSheet: 20_000,
  columnsPerSheet: 250,
  cellCharacters: 32_000,
} as const;

export const WORKBOOK_ENVELOPE_VERSION = '2.0' as const;
const METADATA_MARKER = 'ERP_PLANNING_WORKBOOK';
const METADATA_SHEET = 'ERP Metadata';
const README_SHEET = 'ERP Read Me';
const DICTIONARY_SHEET = 'ERP Data Dictionary';
const SYSTEM_SHEETS = new Set([METADATA_SHEET, README_SHEET, DICTIONARY_SHEET].map((name) => name.toLocaleLowerCase('en-US')));
const METADATA_MAX_CHARACTERS = 5 * 1024 * 1024;
const ROW_ID_HEADER = 'ERP Row ID';
const COLUMN_ID_MARKER = 'ERP Column IDs';

export class WorkbookImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookImportError';
  }
}

interface CellPackageMetadata {
  formula?: string;
  hyperlink?: string;
}

interface SheetPackageMetadata {
  name: string;
  visible: boolean;
  path: string;
  cells: Map<string, CellPackageMetadata>;
}

interface PackageInspection {
  hasExternalLinks: boolean;
  sheets: SheetPackageMetadata[];
}

interface EnvelopeSheet {
  visibleSheetName: string;
  dataset: PlanningDataset;
}

interface WorkbookEnvelopeBody {
  envelopeVersion: typeof WORKBOOK_ENVELOPE_VERSION;
  sourceName: string;
  sourceIdentity: string;
  activeSheetIndex: number;
  sheets: EnvelopeSheet[];
}

interface WorkbookEnvelope extends WorkbookEnvelopeBody {
  envelopeDigest: string;
}

interface EmbeddedWorkbook {
  version: '1.0' | typeof WORKBOOK_ENVELOPE_VERSION;
  sourceName: string;
  sourceIdentity: string;
  activeSheetIndex: number;
  sheets: EnvelopeSheet[];
}

export interface PlanningWorkbookExport {
  bytes: Uint8Array;
  workbook: WorkbookState;
}

function normalizePackagePath(name: string): string {
  if (!name || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name) || name.startsWith('/')) {
    throw new WorkbookImportError('Workbook package contains an unsafe member path.');
  }
  const directory = name.endsWith('/');
  const segments = name.split('/').filter((segment, index, all) => directory && index === all.length - 1 ? false : true);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f]/.test(segment))) {
    throw new WorkbookImportError('Workbook package contains an unsafe member path.');
  }
  return `${segments.join('/')}${directory ? '/' : ''}`;
}

function inspectCentralDirectory(bytes: Uint8Array): Set<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new WorkbookImportError('The selected file is not a valid XLSX ZIP container.');
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new WorkbookImportError('Multi-disk XLSX packages are not supported.');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new WorkbookImportError('ZIP64 XLSX packages are not supported.');
  }
  if (entryCount > IMPORT_LIMITS.entries) throw new WorkbookImportError('Workbook contains too many package entries.');
  if (centralOffset + centralSize > bytes.byteLength) throw new WorkbookImportError('Workbook ZIP directory is malformed.');

  const names = new Set<string>();
  const decoder = new TextDecoder();
  let offset = centralOffset;
  let declaredTotal = 0;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new WorkbookImportError('Workbook ZIP directory is malformed.');
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > bytes.byteLength) throw new WorkbookImportError('Workbook ZIP entry is truncated.');
    if ((flags & 0x1) !== 0) throw new WorkbookImportError('Encrypted XLSX packages are not supported.');
    if (compression !== 0 && compression !== 8) throw new WorkbookImportError('Workbook uses an unsupported ZIP compression method.');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new WorkbookImportError('ZIP64 XLSX members are not supported.');
    declaredTotal += uncompressed;
    if (uncompressed > IMPORT_LIMITS.memberBytes || declaredTotal > IMPORT_LIMITS.uncompressedBytes) {
      throw new WorkbookImportError('Workbook expands beyond the safe processing limit.');
    }
    const decoded = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (decoded.includes('\ufffd')) throw new WorkbookImportError('Workbook contains an invalid ZIP member name.');
    const name = normalizePackagePath(decoded);
    if (names.has(name)) throw new WorkbookImportError('Workbook package contains duplicate member names.');
    names.add(name);
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize) throw new WorkbookImportError('Workbook ZIP directory size is inconsistent.');
  return names;
}

function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function boundedUnzip(bytes: Uint8Array, expectedNames: Set<string>): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let actualTotal = 0;
  let failure: WorkbookImportError | null = null;
  const seen = new Set<string>();
  const unzipper = new Unzip((file) => {
    if (failure) {
      file.terminate();
      return;
    }
    let name: string;
    try {
      name = normalizePackagePath(file.name);
    } catch (error) {
      failure = error instanceof WorkbookImportError ? error : new WorkbookImportError('Workbook contains an unsafe member path.');
      file.terminate();
      return;
    }
    if (!expectedNames.has(name) || seen.has(name)) {
      failure = new WorkbookImportError('Workbook ZIP members do not match the central directory.');
      file.terminate();
      return;
    }
    seen.add(name);
    const chunks: Uint8Array[] = [];
    let memberTotal = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = new WorkbookImportError('The workbook package could not be decompressed safely.');
        file.terminate();
        return;
      }
      memberTotal += chunk.length;
      actualTotal += chunk.length;
      if (memberTotal > IMPORT_LIMITS.memberBytes || actualTotal > IMPORT_LIMITS.uncompressedBytes) {
        failure = new WorkbookImportError('Workbook actual decompression exceeds the safe processing limit.');
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final && !name.endsWith('/')) files[name] = concatChunks(chunks, memberTotal);
    };
    file.start();
  });
  unzipper.register(UnzipPassThrough);
  unzipper.register(UnzipInflate);
  try {
    unzipper.push(bytes, true);
  } catch {
    if (!failure) failure = new WorkbookImportError('The workbook package could not be decompressed safely.');
  }
  if (failure) throw failure;
  const expectedFiles = Array.from(expectedNames).filter((name) => !name.endsWith('/'));
  if (expectedFiles.some((name) => !seen.has(name))) {
    throw new WorkbookImportError('Workbook ZIP members are incomplete.');
  }
  return files;
}

function parseXml(files: Record<string, Uint8Array>, path: string): Document | null {
  const contents = files[path];
  if (!contents) return null;
  let document: Document;
  try {
    document = new DOMParser().parseFromString(strFromU8(contents), 'application/xml');
  } catch {
    throw new WorkbookImportError(`Workbook package XML is malformed (${path}).`);
  }
  if (document.querySelector('parsererror')) throw new WorkbookImportError(`Workbook package XML is malformed (${path}).`);
  return document;
}

function resolvePackageTarget(baseFile: string, target: string): string {
  if (!target || target.includes('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('//')) {
    throw new WorkbookImportError('Workbook relationship target is unsafe or unsupported.');
  }
  const segments = target.startsWith('/') ? [] : baseFile.split('/').slice(0, -1);
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new WorkbookImportError('Workbook relationship escapes the package root.');
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return normalizePackagePath(segments.join('/'));
}

function relationships(document: Document | null, baseFile: string): Map<string, { target: string; external: boolean }> {
  const result = new Map<string, { target: string; external: boolean }>();
  document?.querySelectorAll('Relationship').forEach((relationship) => {
    const id = relationship.getAttribute('Id');
    const target = relationship.getAttribute('Target');
    const external = relationship.getAttribute('TargetMode')?.toLocaleLowerCase('en-US') === 'external';
    if (!id || !target || result.has(id)) throw new WorkbookImportError('Workbook relationships are malformed or duplicated.');
    result.set(id, { target: external ? target : resolvePackageTarget(baseFile, target), external });
  });
  return result;
}

function inspectPackage(bytes: Uint8Array): PackageInspection {
  const expectedNames = inspectCentralDirectory(bytes);
  const files = boundedUnzip(bytes, expectedNames);
  const lowerNames = Array.from(expectedNames, (name) => name.toLocaleLowerCase('en-US'));
  if (lowerNames.some((name) => name.endsWith('vbaproject.bin'))) {
    throw new WorkbookImportError('Macro-enabled workbook content is not accepted.');
  }
  const hasExternalLinks = lowerNames.some((name) => name.startsWith('xl/externallinks/'));
  const workbook = parseXml(files, 'xl/workbook.xml');
  if (!workbook) throw new WorkbookImportError('Workbook package is missing its workbook definition.');
  const workbookRelationships = relationships(parseXml(files, 'xl/_rels/workbook.xml.rels'), 'xl/workbook.xml');
  const sheetNames = new Set<string>();
  const sheets = Array.from(workbook.querySelectorAll('sheet')).map((sheet): SheetPackageMetadata => {
    const name = sheet.getAttribute('name') ?? '';
    const normalizedName = name.toLocaleLowerCase('en-US');
    if (!name || name.length > 31 || sheetNames.has(normalizedName)) {
      throw new WorkbookImportError('Workbook contains an invalid or duplicate worksheet name.');
    }
    sheetNames.add(normalizedName);
    const relationshipId = sheet.getAttribute('r:id') ??
      sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? '';
    const relationship = workbookRelationships.get(relationshipId);
    if (!relationship || relationship.external || !relationship.target.startsWith('xl/worksheets/')) {
      throw new WorkbookImportError(`Worksheet “${name}” has an unsupported package relationship.`);
    }
    const sheetDocument = parseXml(files, relationship.target);
    if (!sheetDocument) throw new WorkbookImportError(`Worksheet “${name}” is missing from the package.`);
    const relationshipPath = relationship.target.replace(/\/([^/]+)$/, '/_rels/$1.rels');
    const sheetRelationships = relationships(parseXml(files, relationshipPath), relationship.target);
    const cells = new Map<string, CellPackageMetadata>();
    sheetDocument.querySelectorAll('c').forEach((cell) => {
      const reference = cell.getAttribute('r');
      const formula = cell.querySelector('f')?.textContent ?? undefined;
      if (reference && formula !== undefined) cells.set(reference, { ...cells.get(reference), formula });
    });
    sheetDocument.querySelectorAll('hyperlink').forEach((link) => {
      const reference = link.getAttribute('ref');
      const id = link.getAttribute('r:id') ??
        link.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const relationshipValue = id ? sheetRelationships.get(id) : null;
      const hyperlink = relationshipValue?.target ?? link.getAttribute('location') ?? undefined;
      if (reference && hyperlink) cells.set(reference, { ...cells.get(reference), hyperlink });
    });
    return {
      name,
      visible: (sheet.getAttribute('state') ?? 'visible') === 'visible',
      path: relationship.target,
      cells,
    };
  });
  return { hasExternalLinks, sheets };
}

export function preflightWorkbookPackage(bytes: Uint8Array, rejectFormulas = false): void {
  const inspection = inspectPackage(bytes);
  if (rejectFormulas && inspection.sheets.some((sheet) => [...sheet.cells.values()].some((cell) => cell.formula !== undefined))) {
    throw new WorkbookImportError('Formula-bearing cells are not supported in this workbook workflow.');
  }
}

function columnLetters(index: number): string {
  let current = index + 1;
  let result = '';
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function toSourceCell(value: unknown, metadata?: CellPackageMetadata): SourceCellInput {
  let scalar: CellScalar;
  let type: SourceCellInput['type'];
  if (value === null || value === undefined || value === '') {
    scalar = value === '' ? '' : null;
    type = 'blank';
  } else if (value instanceof Date) {
    scalar = value.toISOString().slice(0, 10);
    type = 'date';
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkbookImportError('Workbook contains a non-finite numeric value.');
    scalar = value;
    type = 'number';
  } else if (typeof value === 'boolean') {
    scalar = value;
    type = 'boolean';
  } else {
    scalar = String(value);
    type = 'string';
  }
  if (metadata?.formula !== undefined) type = 'formula';
  else if (metadata?.hyperlink) type = 'hyperlink';
  if (typeof scalar === 'string' && scalar.length > IMPORT_LIMITS.cellCharacters) {
    throw new WorkbookImportError('Workbook contains a cell that exceeds the safe text limit.');
  }
  return { value: scalar, type, formula: metadata?.formula, hyperlink: metadata?.hyperlink };
}

function boundedText(value: unknown, max = 1_000): value is string {
  return typeof value === 'string' && value.length <= max;
}

function scalar(value: unknown): value is CellScalar {
  return value === null || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) || boundedText(value, IMPORT_LIMITS.cellCharacters);
}

function validProvenance(value: unknown): value is SourceProvenance {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SourceProvenance>;
  const kinds = new Set(['SYNTHETIC', 'IMPORTED', 'EXTERNAL_IMPORTED', 'USER_ENTERED', 'DERIVED']);
  return !!candidate.kind && kinds.has(candidate.kind) && boundedText(candidate.sourceName) && boundedText(candidate.sheetName) &&
    Number.isSafeInteger(candidate.sourceRow) && Number.isSafeInteger(candidate.sourceColumn) &&
    (candidate.importedAt === undefined || boundedText(candidate.importedAt));
}

function migrateLegacyDataset(value: unknown): unknown {
  if (!value || typeof value !== 'object' || (value as { contractVersion?: unknown }).contractVersion !== '1.0') return value;
  const legacy = value as Record<string, unknown>;
  const synthetic = legacy.synthetic === true;
  const rows = Array.isArray(legacy.rows) ? legacy.rows.map((rowValue) => {
    if (!rowValue || typeof rowValue !== 'object') return rowValue;
    const row = rowValue as Record<string, unknown>;
    const cells = row.cells && typeof row.cells === 'object'
      ? Object.fromEntries(Object.entries(row.cells as Record<string, unknown>).map(([columnId, cellValue]) => {
          if (!cellValue || typeof cellValue !== 'object') return [columnId, cellValue];
          const cell = cellValue as Record<string, unknown>;
          const provenance = cell.provenance as SourceProvenance;
          const originalProvenance: SourceProvenance = {
            ...provenance,
            kind: synthetic ? 'SYNTHETIC' : 'IMPORTED',
          };
          return [columnId, {
            ...cell,
            acceptedRaw: cell.currentRaw,
            originalProvenance,
          }];
        }))
      : row.cells;
    return { ...row, cells, readiness: 'READY' };
  }) : legacy.rows;
  return {
    ...legacy,
    contractVersion: '1.1',
    sourceIdentity: `legacy:${String(legacy.id ?? 'unknown')}`,
    snapshotRevision: null,
    mappingRevision: null,
    readiness: 'MAPPING_REQUIRED',
    rows,
  };
}

function decodeDataset(value: unknown): PlanningDataset {
  const migrated = migrateLegacyDataset(value);
  if (!migrated || typeof migrated !== 'object') throw new WorkbookImportError('ERP workbook metadata does not match the planning contract.');
  const candidate = migrated as Partial<PlanningDataset>;
  const roles = new Set(SEMANTIC_ROLE_DEFINITIONS.map((role) => role.id));
  const mappingStates = new Set(['unmapped', 'suggested', 'user_selected', 'confirmed']);
  const sourceTypes = new Set(['blank', 'string', 'number', 'boolean', 'date', 'formula', 'hyperlink', 'error', 'unknown']);
  const readinessStates = new Set(['MAPPING_REQUIRED', 'BLOCKED', 'PARTIALLY_READY', 'READY']);
  const rowStates = new Set(['READY', 'REVIEW_REQUIRED', 'INVALID']);
  const revision = (input: unknown) => input === null || (typeof input === 'string' && /^sha256:[0-9a-f]{64}$/.test(input));
  if (candidate.contractVersion !== '1.1' || !boundedText(candidate.id) || !boundedText(candidate.sourceIdentity, 2_000) ||
    !revision(candidate.snapshotRevision) || !revision(candidate.mappingRevision) || !boundedText(candidate.name) ||
    !boundedText(candidate.sourceName) || !boundedText(candidate.sheetName) || typeof candidate.synthetic !== 'boolean' ||
    typeof candidate.grainConfirmed !== 'boolean' || typeof candidate.mappingsConfirmed !== 'boolean' ||
    !candidate.readiness || !readinessStates.has(candidate.readiness) || typeof candidate.dirty !== 'boolean' ||
    !Array.isArray(candidate.columns) || !Array.isArray(candidate.rows) ||
    candidate.columns.length > IMPORT_LIMITS.columnsPerSheet || candidate.rows.length > IMPORT_LIMITS.rowsPerSheet) {
    throw new WorkbookImportError('ERP workbook metadata does not match the planning contract.');
  }

  const columnIds = new Set<string>();
  for (const column of candidate.columns) {
    if (!column || typeof column !== 'object' || !boundedText(column.id) || !boundedText(column.originalHeader) ||
      !Number.isSafeInteger(column.sourceIndex) || column.sourceIndex < 0 || !Number.isSafeInteger(column.duplicateOrdinal) ||
      column.duplicateOrdinal < 1 || (column.semanticRole !== null && !roles.has(column.semanticRole)) ||
      (column.suggestedRole !== null && !roles.has(column.suggestedRole)) || !mappingStates.has(column.mappingState) ||
      columnIds.has(column.id)) throw new WorkbookImportError('ERP workbook column metadata is invalid or duplicated.');
    columnIds.add(column.id);
  }
  if (candidate.grainColumnId !== null && (!boundedText(candidate.grainColumnId) || !columnIds.has(candidate.grainColumnId))) {
    throw new WorkbookImportError('ERP workbook grain metadata is invalid.');
  }
  const rowIds = new Set<string>();
  for (const row of candidate.rows) {
    if (!row || typeof row !== 'object' || !boundedText(row.id) || !Number.isSafeInteger(row.sourceRow) || row.sourceRow < 1 ||
      !row.cells || typeof row.cells !== 'object' || rowIds.has(row.id) || !rowStates.has(row.readiness) ||
      Object.keys(row.cells).length !== columnIds.size) throw new WorkbookImportError('ERP workbook row metadata is invalid or duplicated.');
    rowIds.add(row.id);
    for (const columnId of columnIds) {
      const cell = row.cells[columnId];
      if (!cell || typeof cell !== 'object' || !scalar(cell.originalRaw) || !scalar(cell.currentRaw) ||
        !scalar(cell.acceptedRaw) || !scalar(cell.normalized) || !sourceTypes.has(cell.sourceType) ||
        typeof cell.modified !== 'boolean' || !validProvenance(cell.provenance) || !validProvenance(cell.originalProvenance) ||
        (cell.formula !== undefined && !boundedText(cell.formula, IMPORT_LIMITS.cellCharacters)) ||
        (cell.hyperlink !== undefined && !boundedText(cell.hyperlink, IMPORT_LIMITS.cellCharacters))) {
        throw new WorkbookImportError('ERP workbook cell metadata is invalid.');
      }
    }
  }
  return validateDataset({ ...candidate, issues: [] } as PlanningDataset);
}

function serializedMetadata(sheet: { sheet: string; data: unknown[][] }): { version: unknown; serialized: string } {
  if (sheet.data[0]?.[0] !== METADATA_MARKER) {
    throw new WorkbookImportError(`Worksheet “${METADATA_SHEET}” is reserved and does not contain valid ERP metadata.`);
  }
  const version = sheet.data[1]?.[0];
  const serialized = sheet.data.slice(2).map((row) => typeof row[0] === 'string' ? row[0] : '').join('');
  if (!serialized || serialized.length > METADATA_MAX_CHARACTERS) {
    throw new WorkbookImportError('ERP workbook metadata is missing or exceeds the safe limit.');
  }
  return { version, serialized };
}

async function readEmbeddedMetadata(parsedSheets: Array<{ sheet: string; data: unknown[][] }>): Promise<EmbeddedWorkbook | null> {
  const sheet = parsedSheets.find((candidate) => candidate.sheet === METADATA_SHEET);
  if (!sheet) return null;
  const { version, serialized } = serializedMetadata(sheet);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new WorkbookImportError('ERP workbook metadata is malformed.');
  }
  if (version === '1.0') {
    const dataset = decodeDataset(parsed);
    return {
      version: '1.0',
      sourceName: dataset.sourceName,
      sourceIdentity: dataset.sourceIdentity,
      activeSheetIndex: 0,
      sheets: [{ visibleSheetName: 'Planning Data', dataset }],
    };
  }
  if (version !== WORKBOOK_ENVELOPE_VERSION || !parsed || typeof parsed !== 'object') {
    throw new WorkbookImportError(`ERP workbook envelope version “${String(version)}” is not supported.`);
  }
  const envelope = parsed as Partial<WorkbookEnvelope>;
  if (envelope.envelopeVersion !== WORKBOOK_ENVELOPE_VERSION || !boundedText(envelope.sourceName) ||
    !boundedText(envelope.sourceIdentity, 2_000) || !Number.isSafeInteger(envelope.activeSheetIndex) ||
    !Array.isArray(envelope.sheets) || envelope.sheets.length < 1 || envelope.sheets.length > IMPORT_LIMITS.sheets ||
    !boundedText(envelope.envelopeDigest, 100) || !/^sha256:[0-9a-f]{64}$/.test(envelope.envelopeDigest)) {
    throw new WorkbookImportError('ERP workbook envelope metadata is invalid.');
  }
  const names = new Set<string>();
  const sheets = envelope.sheets.map((item) => {
    if (!item || typeof item !== 'object' || !boundedText(item.visibleSheetName, 31)) {
      throw new WorkbookImportError('ERP workbook sheet metadata is invalid.');
    }
    const normalizedName = item.visibleSheetName.toLocaleLowerCase('en-US');
    if (names.has(normalizedName) || SYSTEM_SHEETS.has(normalizedName)) {
      throw new WorkbookImportError('ERP workbook sheet metadata collides with another or reserved worksheet.');
    }
    names.add(normalizedName);
    return { visibleSheetName: item.visibleSheetName, dataset: decodeDataset(item.dataset) };
  });
  const activeSheetIndex = envelope.activeSheetIndex;
  if (typeof activeSheetIndex !== 'number' || activeSheetIndex < 0 || activeSheetIndex >= sheets.length) {
    throw new WorkbookImportError('ERP workbook active-sheet metadata is invalid.');
  }
  const body: WorkbookEnvelopeBody = {
    envelopeVersion: WORKBOOK_ENVELOPE_VERSION,
    sourceName: envelope.sourceName,
    sourceIdentity: envelope.sourceIdentity,
    activeSheetIndex,
    sheets,
  };
  if (await canonicalDigest(body) !== envelope.envelopeDigest) {
    throw new WorkbookImportError('ERP workbook metadata digest does not match its contents.');
  }
  for (const item of sheets) {
    if (!item.dataset.mappingRevision || !item.dataset.snapshotRevision) {
      throw new WorkbookImportError('ERP workbook dataset revision evidence is missing.');
    }
    const stamped = await stampDatasetRevisions(item.dataset);
    if (stamped.mappingRevision !== item.dataset.mappingRevision || stamped.snapshotRevision !== item.dataset.snapshotRevision) {
      throw new WorkbookImportError(`ERP metadata for worksheet “${item.dataset.sheetName}” has conflicting dataset revisions.`);
    }
  }
  return { version: WORKBOOK_ENVELOPE_VERSION, ...body };
}

function sourceSheetNames(parsedSheets: Array<{ sheet: string }>): string[] {
  return parsedSheets.map((sheet) => sheet.sheet).filter((name) => !SYSTEM_SHEETS.has(name.toLocaleLowerCase('en-US')));
}

function safeVisibleValue(value: CellScalar): CellScalar {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function scalarEqual(left: CellScalar, right: CellScalar): boolean {
  return typeof left === 'number' && typeof right === 'number' ? Object.is(left, right) : left === right;
}

function externalCell(
  previous: PlanningCell,
  input: SourceCellInput,
  sourceName: string,
  sheetName: string,
  sourceRow: number,
  sourceColumn: number,
): PlanningCell {
  const provenance: SourceProvenance = {
    kind: 'EXTERNAL_IMPORTED',
    sourceName,
    sheetName,
    sourceRow,
    sourceColumn,
    importedAt: new Date().toISOString(),
  };
  return {
    ...previous,
    currentRaw: input.value,
    acceptedRaw: input.value,
    normalized: input.value,
    sourceType: input.type ?? 'unknown',
    provenance,
    modified: !scalarEqual(input.value, previous.originalRaw),
    formula: input.formula,
    hyperlink: input.hyperlink,
  };
}

async function reconcileIdentitySheet(
  metadata: EnvelopeSheet,
  visible: { sheet: string; data: unknown[][] },
  packageSheet: SheetPackageMetadata,
  sourceName: string,
): Promise<PlanningDataset> {
  const dataset = metadata.dataset;
  const expectedColumns = dataset.columns.length + 1;
  const expectedRows = dataset.rows.length + 2;
  const columnCount = Math.max(0, ...visible.data.map((row) => row.length));
  if (visible.data.length !== expectedRows || columnCount !== expectedColumns) {
    throw new WorkbookImportError(`Worksheet “${visible.sheet}” changed rows or columns and cannot be reconciled safely.`);
  }
  const expectedHeaders = [ROW_ID_HEADER, ...dataset.columns.map((column) => column.originalHeader)];
  const actualHeaders = Array.from({ length: expectedColumns }, (_, index) => String(visible.data[0]?.[index] ?? ''));
  if (actualHeaders.some((header, index) => header !== expectedHeaders[index])) {
    throw new WorkbookImportError(`Worksheet “${visible.sheet}” changed or reordered source headers.`);
  }
  const expectedColumnIds = [COLUMN_ID_MARKER, ...dataset.columns.map((column) => column.id)];
  const actualColumnIds = Array.from({ length: expectedColumns }, (_, index) => String(visible.data[1]?.[index] ?? ''));
  if (actualColumnIds.some((identity, index) => identity !== expectedColumnIds[index])) {
    throw new WorkbookImportError(`Worksheet “${visible.sheet}” changed or reordered ERP column identities.`);
  }
  const rows = dataset.rows.map((row, rowIndex) => {
    const visibleRow = visible.data[rowIndex + 2] ?? [];
    const rowIdentity = String(visibleRow[0] ?? '');
    if (rowIdentity !== row.id) {
      throw new WorkbookImportError(`Worksheet “${visible.sheet}” changed, added, deleted, or reordered ERP row identities.`);
    }
    const cells = { ...row.cells };
    dataset.columns.forEach((column, columnIndex) => {
      const reference = `${columnLetters(columnIndex + 1)}${rowIndex + 3}`;
      const packageMetadata = packageSheet.cells.get(reference);
      const prior = row.cells[column.id];
      if (packageMetadata?.formula !== undefined) {
        throw new WorkbookImportError(`Worksheet “${visible.sheet}” contains an unsupported formula change at ${reference}.`);
      }
      const input = toSourceCell(visibleRow[columnIndex + 1], packageMetadata);
      const expectedVisible = safeVisibleValue(prior.currentRaw);
      if (!scalarEqual(input.value, expectedVisible)) {
        if (prior.formula) {
          throw new WorkbookImportError(`Worksheet “${visible.sheet}” changed a formula-derived source cell at ${reference}; explicit remapping is required.`);
        }
        cells[column.id] = externalCell(prior, input, sourceName, dataset.sheetName, rowIndex + 3, columnIndex + 2);
      }
    });
    return { ...row, cells };
  });
  const reconciled = validateDataset({ ...dataset, rows, dirty: false, snapshotRevision: null });
  return stampDatasetRevisions(reconciled);
}

function rowSignature(values: CellScalar[]): string {
  return JSON.stringify(values.map((value) => safeVisibleValue(value)));
}

async function reconcileLegacySheet(
  metadata: EnvelopeSheet,
  visible: { sheet: string; data: unknown[][] },
  packageSheet: SheetPackageMetadata,
  sourceName: string,
): Promise<PlanningDataset> {
  const dataset = metadata.dataset;
  const columnCount = Math.max(0, ...visible.data.map((row) => row.length));
  if (visible.data.length !== dataset.rows.length + 1 || columnCount !== dataset.columns.length) {
    throw new WorkbookImportError('Legacy ERP worksheet structure changed and cannot be reconciled safely.');
  }
  const headers = Array.from({ length: columnCount }, (_, index) => String(visible.data[0]?.[index] ?? ''));
  if (headers.some((header, index) => header !== dataset.columns[index].originalHeader)) {
    throw new WorkbookImportError('Legacy ERP worksheet headers changed or were reordered.');
  }
  const baselineSignatures = dataset.rows.map((row) => rowSignature(dataset.columns.map((column) => row.cells[column.id].currentRaw)));
  const visibleSignatures = visible.data.slice(1).map((row) => rowSignature(dataset.columns.map((_, index) => toSourceCell(row[index]).value)));
  if (new Set(baselineSignatures).size === baselineSignatures.length &&
    visibleSignatures.every((signature) => baselineSignatures.includes(signature)) &&
    visibleSignatures.some((signature, index) => signature !== baselineSignatures[index])) {
    throw new WorkbookImportError('Legacy ERP worksheet rows were reordered; stable row identities are unavailable for safe reconciliation.');
  }
  const rows = dataset.rows.map((row, rowIndex) => {
    const cells = { ...row.cells };
    dataset.columns.forEach((column, columnIndex) => {
      const reference = `${columnLetters(columnIndex)}${rowIndex + 2}`;
      const packageMetadata = packageSheet.cells.get(reference);
      if (packageMetadata?.formula !== undefined) throw new WorkbookImportError(`Legacy ERP worksheet contains an unsupported formula change at ${reference}.`);
      const input = toSourceCell(visible.data[rowIndex + 1]?.[columnIndex], packageMetadata);
      const prior = row.cells[column.id];
      if (!scalarEqual(input.value, safeVisibleValue(prior.currentRaw))) {
        cells[column.id] = externalCell(prior, input, sourceName, dataset.sheetName, rowIndex + 2, columnIndex + 1);
      }
    });
    return { ...row, cells };
  });
  return stampDatasetRevisions(validateDataset({ ...dataset, rows, dirty: false, snapshotRevision: null }));
}

function addExternalLinkWarning(dataset: PlanningDataset): PlanningDataset {
  return {
    ...dataset,
    issues: [...dataset.issues, {
      id: `issue-${stableHash(`${dataset.id}-external-links`)}`,
      severity: 'warning',
      code: 'EXTERNAL_LINK_CONTENT',
      message: 'The source package declares external-link content; ERP did not resolve or contact it.',
    }],
    readiness: dataset.readiness === 'READY' ? 'PARTIALLY_READY' : dataset.readiness,
  };
}

export async function readPlanningWorkbook(bytes: Uint8Array, sourceName: string): Promise<WorkbookState> {
  if (!sourceName.toLocaleLowerCase('en-US').endsWith('.xlsx')) {
    throw new WorkbookImportError('Select an .xlsx workbook. Macro-enabled and legacy formats are not accepted.');
  }
  if (bytes.byteLength === 0 || bytes.byteLength > IMPORT_LIMITS.compressedBytes) {
    throw new WorkbookImportError(`Workbook must be between 1 byte and ${IMPORT_LIMITS.compressedBytes / 1024 / 1024} MB.`);
  }
  const packageInspection = inspectPackage(bytes);
  let parsedSheets: Array<{ sheet: string; data: unknown[][] }>;
  try {
    parsedSheets = await readExcelFile(bytes.slice().buffer as ArrayBuffer);
  } catch {
    throw new WorkbookImportError('The workbook could not be parsed as a valid XLSX file.');
  }
  const parsedNames = parsedSheets.map((sheet) => sheet.sheet);
  if (new Set(parsedNames.map((name) => name.toLocaleLowerCase('en-US'))).size !== parsedNames.length) {
    throw new WorkbookImportError('Workbook contains duplicate worksheet names.');
  }
  const embedded = await readEmbeddedMetadata(parsedSheets);
  const nonSystemHidden = packageInspection.sheets.filter((sheet) => !sheet.visible && !SYSTEM_SHEETS.has(sheet.name.toLocaleLowerCase('en-US')));
  if (nonSystemHidden.length > 0) {
    throw new WorkbookImportError(`Hidden worksheet “${nonSystemHidden[0].name}” is not supported because silently omitting it could lose planning data.`);
  }

  if (embedded) {
    const actualPlanningNames = sourceSheetNames(parsedSheets);
    const expectedPlanningNames = embedded.sheets.map((sheet) => sheet.visibleSheetName);
    if (actualPlanningNames.length !== expectedPlanningNames.length ||
      actualPlanningNames.some((name, index) => name !== expectedPlanningNames[index])) {
      throw new WorkbookImportError('ERP workbook planning worksheets were added, deleted, renamed, or reordered.');
    }
    const reconciled = await Promise.all(embedded.sheets.map((item) => {
      const visible = parsedSheets.find((sheet) => sheet.sheet === item.visibleSheetName);
      const packageSheet = packageInspection.sheets.find((sheet) => sheet.name === item.visibleSheetName);
      if (!visible || !packageSheet || !packageSheet.visible) {
        throw new WorkbookImportError(`ERP planning worksheet “${item.visibleSheetName}” is missing or hidden.`);
      }
      return embedded.version === '1.0'
        ? reconcileLegacySheet(item, visible, packageSheet, sourceName)
        : reconcileIdentitySheet(item, visible, packageSheet, sourceName);
    }));
    return {
      sourceName,
      sourceIdentity: `sha256:${await sha256Hex(bytes)}`,
      sheets: packageInspection.hasExternalLinks ? reconciled.map(addExternalLinkWarning) : reconciled,
      activeSheetIndex: embedded.activeSheetIndex,
    };
  }

  const reserved = parsedSheets.find((sheet) => SYSTEM_SHEETS.has(sheet.sheet.toLocaleLowerCase('en-US')));
  if (reserved) throw new WorkbookImportError(`Worksheet name “${reserved.sheet}” is reserved for ERP workbook evidence.`);
  const visibleNames = new Set(packageInspection.sheets.filter((sheet) => sheet.visible).map((sheet) => sheet.name));
  const visibleSheets = parsedSheets.filter((sheet) => visibleNames.has(sheet.sheet));
  if (visibleSheets.length === 0) throw new WorkbookImportError('Workbook has no visible worksheets.');
  if (visibleSheets.length > IMPORT_LIMITS.sheets) throw new WorkbookImportError('Workbook contains too many worksheets.');
  const sourceIdentity = `sha256:${await sha256Hex(bytes)}`;
  const sheets = await Promise.all(visibleSheets.map(async (sheet) => {
    if (sheet.data.length < 1) throw new WorkbookImportError(`Worksheet “${sheet.sheet}” is empty.`);
    if (sheet.data.length - 1 > IMPORT_LIMITS.rowsPerSheet) throw new WorkbookImportError(`Worksheet “${sheet.sheet}” exceeds the row limit.`);
    const columnCount = Math.max(0, ...sheet.data.map((row) => row.length));
    if (columnCount > IMPORT_LIMITS.columnsPerSheet) throw new WorkbookImportError(`Worksheet “${sheet.sheet}” exceeds the column limit.`);
    const packageSheet = packageInspection.sheets.find((candidate) => candidate.name === sheet.sheet);
    if (!packageSheet) throw new WorkbookImportError(`Worksheet “${sheet.sheet}” package metadata is missing.`);
    const headers = Array.from({ length: columnCount }, (_, index) => {
      const header = sheet.data[0]?.[index];
      return header === null || header === undefined ? '' : String(header);
    });
    const rows = sheet.data.slice(1).map((row, rowIndex) => Array.from({ length: columnCount }, (_, columnIndex) => {
      const reference = `${columnLetters(columnIndex)}${rowIndex + 2}`;
      return toSourceCell(row[columnIndex], packageSheet.cells.get(reference));
    }));
    let dataset = createDatasetFromTable({ sourceName, sourceIdentity, sheetName: sheet.sheet, synthetic: false, headers, rows });
    dataset = await stampDatasetRevisions(dataset);
    return packageInspection.hasExternalLinks ? addExternalLinkWarning(dataset) : dataset;
  }));
  return { sourceName, sourceIdentity, sheets, activeSheetIndex: 0 };
}

function safeSpreadsheetCell(value: CellScalar, header = false): Cell {
  const safeValue = safeVisibleValue(value);
  return {
    value: safeValue ?? '',
    type: typeof safeValue === 'number' ? Number : typeof safeValue === 'boolean' ? Boolean : String,
    fontWeight: header ? 'bold' : undefined,
    textColor: header ? '#FFFFFF' : undefined,
    backgroundColor: header ? '#173A4F' : undefined,
    wrap: true,
  };
}

function safeSheetName(sourceName: string, used: Set<string>): string {
  const cleaned = sourceName.replace(/[\\/*?:[\]]/g, ' ').replace(/[\u0000-\u001f]/g, ' ').trim().replace(/^'+|'+$/g, '') || 'Planning Data';
  let base = cleaned.slice(0, 31);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase('en-US')) || SYSTEM_SHEETS.has(candidate.toLocaleLowerCase('en-US'))) {
    const ending = ` (${suffix})`;
    candidate = `${base.slice(0, 31 - ending.length)}${ending}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

function planningSheet(dataset: PlanningDataset, visibleSheetName: string): Sheet<Blob> {
  const data: SheetData = [
    [safeSpreadsheetCell(ROW_ID_HEADER, true), ...dataset.columns.map((column) => safeSpreadsheetCell(column.originalHeader, true))],
    [safeSpreadsheetCell(COLUMN_ID_MARKER), ...dataset.columns.map((column) => safeSpreadsheetCell(column.id))],
    ...dataset.rows.map((row) => [
      safeSpreadsheetCell(row.id),
      ...dataset.columns.map((column) => safeSpreadsheetCell(row.cells[column.id]?.currentRaw ?? null)),
    ]),
  ];
  return {
    data,
    sheet: visibleSheetName,
    stickyRowsCount: 2,
    stickyColumnsCount: 1,
    columns: [{ width: 24 }, ...dataset.columns.map(() => ({ width: 20 }))],
  };
}

export async function preparePlanningWorkbook(workbook: WorkbookState): Promise<PlanningWorkbookExport> {
  if (workbook.sheets.length < 1 || workbook.sheets.length > IMPORT_LIMITS.sheets) {
    throw new Error('Workbook must contain a supported number of planning worksheets.');
  }
  const persisted = markWorkbookPersisted(workbook);
  const stamped = await stampWorkbookRevisions(persisted);
  const used = new Set<string>();
  const envelopeSheets = stamped.sheets.map((dataset) => ({
    visibleSheetName: safeSheetName(dataset.sheetName, used),
    dataset,
  }));
  const body: WorkbookEnvelopeBody = {
    envelopeVersion: WORKBOOK_ENVELOPE_VERSION,
    sourceName: stamped.sourceName,
    sourceIdentity: stamped.sourceIdentity,
    activeSheetIndex: stamped.activeSheetIndex,
    sheets: envelopeSheets,
  };
  const envelope: WorkbookEnvelope = { ...body, envelopeDigest: await canonicalDigest(body) };
  const serialized = JSON.stringify(envelope);
  if (serialized.length > METADATA_MAX_CHARACTERS) throw new Error('Workbook metadata exceeds the supported export size.');

  const dictionaryData: SheetData = [
    ['Worksheet', 'Column ID', 'Original header', 'Source position', 'Semantic role', 'Mapping state', 'Dataset grain']
      .map((value) => safeSpreadsheetCell(value, true)),
    ...envelopeSheets.flatMap((item) => item.dataset.columns.map((column) => [
      item.visibleSheetName,
      column.id,
      column.originalHeader,
      column.sourceIndex + 1,
      column.semanticRole ?? 'Unmapped',
      column.mappingState,
      column.id === item.dataset.grainColumnId ? 'Yes' : 'No',
    ].map((value) => safeSpreadsheetCell(value)))),
  ];
  const readmeData: SheetData = [
    [safeSpreadsheetCell('Enterprise Resource Planner workbook', true)],
    [safeSpreadsheetCell('Envelope version'), safeSpreadsheetCell(WORKBOOK_ENVELOPE_VERSION)],
    [safeSpreadsheetCell('Planning worksheets'), safeSpreadsheetCell(stamped.sheets.length)],
    [safeSpreadsheetCell('Active worksheet'), safeSpreadsheetCell(envelopeSheets[stamped.activeSheetIndex]?.visibleSheetName ?? envelopeSheets[0].visibleSheetName)],
    [safeSpreadsheetCell('Editing'), safeSpreadsheetCell('Edit planning values only. Do not change ERP row IDs, the ERP column-ID row, worksheet names, or worksheet structure.')],
    [safeSpreadsheetCell('Safety'), safeSpreadsheetCell('Formulas are unsupported planning edits and are never executed or trusted as canonical values.')],
  ];
  const metadataData: SheetData = [[METADATA_MARKER], [WORKBOOK_ENVELOPE_VERSION]];
  for (let offset = 0; offset < serialized.length; offset += 30_000) metadataData.push([serialized.slice(offset, offset + 30_000)]);

  const sheets: Sheet<Blob>[] = [
    ...envelopeSheets.map((item) => planningSheet(item.dataset, item.visibleSheetName)),
    { data: dictionaryData, sheet: DICTIONARY_SHEET, stickyRowsCount: 1, columns: Array.from({ length: 7 }, () => ({ width: 24 })) },
    { data: readmeData, sheet: README_SHEET, columns: [{ width: 24 }, { width: 80 }] },
    { data: metadataData, sheet: METADATA_SHEET, columns: [{ width: 16 }] },
  ];
  const blob = await writeExcelFile(sheets, { fontFamily: 'Aptos', fontSize: 11 }).toBlob();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), workbook: stamped };
}

export async function createPlanningWorkbook(workbook: WorkbookState): Promise<Uint8Array> {
  return (await preparePlanningWorkbook(workbook)).bytes;
}

export function planningWorkbookFilename(workbook: WorkbookState, now = new Date()): string {
  const base = workbook.sourceName.replace(/\.xlsx$/i, '');
  const slug = base.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'planning-workbook';
  return `erp-planning-workbook-${slug}-${now.toISOString().slice(0, 10)}.xlsx`;
}

export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
