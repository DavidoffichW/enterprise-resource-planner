import type { CellScalar, PlanningDataset, SourceProvenance, WorkbookState } from '../contracts';

const MAPPING_REVISION_SCHEMA = 'erp-mapping-revision/1';
const SNAPSHOT_REVISION_SCHEMA = 'erp-planning-snapshot/1';

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Canonical evidence cannot contain a non-finite number.');
  return Object.is(value, -0) ? '-0' : String(value);
}

export function canonicalSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalSerialize(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`).join(',')}}`;
  }
  throw new Error(`Unsupported canonical evidence value: ${typeof value}.`);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function canonicalDigest(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalSerialize(value))}`;
}

function provenanceEvidence(provenance: SourceProvenance) {
  return {
    kind: provenance.kind,
    sourceName: provenance.sourceName,
    sheetName: provenance.sheetName,
    sourceRow: provenance.sourceRow,
    sourceColumn: provenance.sourceColumn,
  };
}

function scalarEvidence(value: CellScalar): CellScalar {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Planning evidence cannot contain a non-finite number.');
  }
  return value;
}

export async function computeMappingRevision(dataset: PlanningDataset): Promise<string> {
  return canonicalDigest({
    schema: MAPPING_REVISION_SCHEMA,
    logicalDatasetId: dataset.id,
    grainColumnId: dataset.grainColumnId,
    grainConfirmed: dataset.grainConfirmed,
    mappingsConfirmed: dataset.mappingsConfirmed,
    columns: dataset.columns.map((column) => ({
      id: column.id,
      semanticRole: column.semanticRole,
      mappingState: column.mappingState,
    })),
  });
}

export async function computeSnapshotRevision(
  dataset: PlanningDataset,
  mappingRevision = dataset.mappingRevision,
): Promise<string> {
  const effectiveMappingRevision = mappingRevision ?? await computeMappingRevision(dataset);
  return canonicalDigest({
    schema: SNAPSHOT_REVISION_SCHEMA,
    contractVersion: dataset.contractVersion,
    logicalDatasetId: dataset.id,
    sourceIdentity: dataset.sourceIdentity,
    sourceName: dataset.sourceName,
    sheetName: dataset.sheetName,
    synthetic: dataset.synthetic,
    mappingRevision: effectiveMappingRevision,
    columns: dataset.columns.map((column) => ({
      id: column.id,
      originalHeader: column.originalHeader,
      sourceIndex: column.sourceIndex,
      duplicateOrdinal: column.duplicateOrdinal,
    })),
    rows: dataset.rows.map((row) => ({
      id: row.id,
      sourceRow: row.sourceRow,
      cells: dataset.columns.map((column) => {
        const cell = row.cells[column.id];
        return {
          columnId: column.id,
          originalRaw: scalarEvidence(cell.originalRaw),
          currentRaw: scalarEvidence(cell.currentRaw),
          normalized: scalarEvidence(cell.normalized),
          sourceType: cell.sourceType,
          provenance: provenanceEvidence(cell.provenance),
          originalProvenance: provenanceEvidence(cell.originalProvenance),
          formula: cell.formula ?? null,
          hyperlink: cell.hyperlink ?? null,
        };
      }),
    })),
  });
}

export async function stampDatasetRevisions(dataset: PlanningDataset): Promise<PlanningDataset> {
  const mappingRevision = await computeMappingRevision(dataset);
  const snapshotRevision = await computeSnapshotRevision(dataset, mappingRevision);
  return { ...dataset, mappingRevision, snapshotRevision };
}

export async function stampWorkbookRevisions(workbook: WorkbookState): Promise<WorkbookState> {
  return { ...workbook, sheets: await Promise.all(workbook.sheets.map(stampDatasetRevisions)) };
}
