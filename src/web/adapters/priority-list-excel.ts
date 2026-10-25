import readExcelFile from 'read-excel-file/browser';
import writeExcelFile, { type SheetData } from 'write-excel-file/browser';
import type { CellScalar, PriorityListRevision } from '../../contracts';
import { createPriorityListRevision } from '../../core';
import { preflightWorkbookPackage } from './excel';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 20_000;

export interface PriorityListInspection {
  sourceName: string;
  sheetName: string;
  headers: string[];
  rows: CellScalar[][];
}

function scalar(value: unknown): CellScalar {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export async function inspectPriorityListWorkbook(bytes: Uint8Array, sourceName: string): Promise<PriorityListInspection> {
  if (!sourceName.toLocaleLowerCase('en-US').endsWith('.xlsx')) throw new Error('Priority List import requires an .xlsx workbook.');
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Priority List workbook must be between 1 byte and 5 MB.');
  preflightWorkbookPackage(bytes, true);
  let sheetName: string;
  let rows: unknown[][];
  try {
    const sheets = await readExcelFile(bytes.slice().buffer as ArrayBuffer);
    if (!sheets.length) throw new Error('No visible worksheet.');
    sheetName = sheets[0].sheet;
    rows = sheets[0].data;
  } catch { throw new Error('Priority List workbook could not be parsed.'); }
  if (rows.length < 2) throw new Error('Priority List workbook must contain a header and at least one entry.');
  if (rows.length - 1 > MAX_ROWS) throw new Error('Priority List workbook exceeds the row limit.');
  const width = Math.max(...rows.map((row) => row.length));
  const headers = Array.from({ length: width }, (_, index) => String(rows[0]?.[index] ?? ''));
  if (headers.some((header) => !header.trim()) || new Set(headers.map((header) => header.toLocaleLowerCase('en-US'))).size !== headers.length) {
    throw new Error('Priority List headers must be non-empty and unique.');
  }
  return { sourceName, sheetName, headers, rows: rows.slice(1).map((row) => Array.from({ length: width }, (_, index) => scalar(row[index]))) };
}

export async function createPriorityListFromInspection(
  inspection: PriorityListInspection,
  name: string,
  identifierHeader: string,
  rankHeader: string,
  logicalListId?: string,
): Promise<PriorityListRevision> {
  const identifierIndex = inspection.headers.indexOf(identifierHeader);
  const rankIndex = inspection.headers.indexOf(rankHeader);
  if (identifierIndex < 0 || rankIndex < 0 || identifierIndex === rankIndex) throw new Error('Select distinct identifier and Priority Rank columns.');
  const entries = inspection.rows.map((row) => {
    const rawItemId = row[identifierIndex] ?? null;
    const rawPriorityRank = row[rankIndex] ?? null;
    const itemId = String(rawItemId ?? '').trim();
    const parsedRank = typeof rawPriorityRank === 'number'
      ? rawPriorityRank
      : /^\d+$/.test(String(rawPriorityRank ?? '').trim()) ? Number(rawPriorityRank) : null;
    const priorityRank = parsedRank !== null && Number.isSafeInteger(parsedRank) && parsedRank > 0 ? parsedRank : null;
    const additionalFields = Object.fromEntries(inspection.headers
      .filter((_, index) => index !== identifierIndex && index !== rankIndex)
      .map((header) => [header, row[inspection.headers.indexOf(header)] ?? null]));
    return { itemId, priorityRank, rawItemId, rawPriorityRank, sourceRow: inspection.rows.indexOf(row) + 2, additionalFields };
  });
  return createPriorityListRevision(name, identifierHeader, rankHeader, entries, inspection.sourceName, new Date().toISOString(), logicalListId);
}

export async function exportPriorityList(list: PriorityListRevision): Promise<Uint8Array> {
  const extras = [...new Set(list.entries.flatMap((entry) => Object.keys(entry.additionalFields)))];
  const data: SheetData = [
    [list.identifierHeader, list.rankHeader, ...extras],
    ...list.entries.slice().sort((left, right) => left.sourceRow - right.sourceRow).map((entry) => [entry.rawItemId ?? entry.itemId, entry.rawPriorityRank ?? entry.priorityRank ?? '', ...extras.map((header) => entry.additionalFields[header] ?? '')]),
  ];
  const blob = await writeExcelFile([{ sheet: 'Priority List', data }]).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}
