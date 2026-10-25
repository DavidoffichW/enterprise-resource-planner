import type {
  CellScalar,
  PlanningCell,
  PlanningColumn,
  PlanningDataset,
  PlanningRow,
  SourceCellInput,
  SourceTable,
  ValidationIssue,
  WorkbookState,
} from '../contracts';
import { normalizeForRole } from './normalization';
import { suggestSemanticRole } from './semantic-mapping';
import { makeColumnId, makeDatasetId, makeRowId, stableHash } from './stable-identity';

function isSourceCellInput(value: CellScalar | SourceCellInput): value is SourceCellInput {
  return typeof value === 'object' && value !== null && 'value' in value;
}

function inferType(value: CellScalar): PlanningCell['sourceType'] {
  if (value === null || value === '') return 'blank';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function scalarEqual(left: CellScalar, right: CellScalar): boolean {
  return typeof left === 'number' && typeof right === 'number' ? Object.is(left, right) : left === right;
}

function datasetDirty(rows: PlanningRow[], columns: PlanningColumn[]): boolean {
  return rows.some((row) => columns.some((column) => {
    const cell = row.cells[column.id];
    return cell ? !scalarEqual(cell.currentRaw, cell.acceptedRaw) : true;
  }));
}

export function createDatasetFromTable(table: SourceTable): PlanningDataset {
  const headerCounts = new Map<string, number>();
  const columns: PlanningColumn[] = table.headers.map((header, sourceIndex) => {
    const ordinal = (headerCounts.get(header) ?? 0) + 1;
    headerCounts.set(header, ordinal);
    const suggestedRole = suggestSemanticRole(header);
    return {
      id: makeColumnId(sourceIndex, header),
      originalHeader: header,
      sourceIndex,
      duplicateOrdinal: ordinal,
      semanticRole: suggestedRole,
      suggestedRole,
      mappingState: suggestedRole ? 'suggested' : 'unmapped',
    };
  });

  const importedAt = table.synthetic ? undefined : new Date().toISOString();
  const rows: PlanningRow[] = table.rows.map((sourceCells, rowIndex) => {
    const sourceRow = rowIndex + 2;
    const cells: Record<string, PlanningCell> = {};
    columns.forEach((column) => {
      const supplied = sourceCells[column.sourceIndex] ?? null;
      const input = isSourceCellInput(supplied) ? supplied : { value: supplied };
      const provenance = {
        kind: table.synthetic ? 'SYNTHETIC' as const : 'IMPORTED' as const,
        sourceName: table.sourceName,
        sheetName: table.sheetName,
        sourceRow,
        sourceColumn: column.sourceIndex + 1,
        importedAt,
      };
      cells[column.id] = {
        originalRaw: input.value,
        currentRaw: input.value,
        acceptedRaw: input.value,
        normalized: input.value,
        sourceType: input.type ?? inferType(input.value),
        provenance,
        originalProvenance: provenance,
        modified: false,
        formula: input.formula,
        hyperlink: input.hyperlink,
      };
    });
    return {
      id: makeRowId(table.sourceName, table.sheetName, sourceRow),
      sourceRow,
      cells,
      readiness: 'READY',
    };
  });

  const suggestedGrain = columns.find((column) => column.suggestedRole === 'planned_job_identifier')?.id ?? null;
  const initial: PlanningDataset = {
    contractVersion: '1.1',
    id: makeDatasetId(table.sourceName, table.sheetName, table.headers),
    sourceIdentity: table.sourceIdentity ?? `source-${stableHash(`${table.sourceName}\u0000${table.sheetName}`)}`,
    snapshotRevision: null,
    mappingRevision: null,
    name: table.sheetName,
    sourceName: table.sourceName,
    sheetName: table.sheetName,
    synthetic: table.synthetic,
    columns,
    rows,
    grainColumnId: suggestedGrain,
    grainConfirmed: false,
    mappingsConfirmed: false,
    readiness: 'MAPPING_REQUIRED',
    dirty: false,
    issues: [],
  };
  return validateDataset(initial);
}

export function editCell(
  dataset: PlanningDataset,
  rowId: string,
  columnId: string,
  value: CellScalar,
): PlanningDataset {
  const column = dataset.columns.find((candidate) => candidate.id === columnId);
  if (!column) return dataset;
  const rows = dataset.rows.map((row) => {
    if (row.id !== rowId) return row;
    const existing = row.cells[columnId];
    if (!existing) return row;
    const restoredToOriginal = scalarEqual(value, existing.originalRaw);
    const updated: PlanningCell = {
      ...existing,
      currentRaw: value,
      sourceType: inferType(value),
      modified: !restoredToOriginal,
      provenance: restoredToOriginal ? existing.originalProvenance : {
        ...existing.provenance,
        kind: 'USER_ENTERED',
      },
      formula: undefined,
      hyperlink: undefined,
    };
    const normalized = normalizeForRole(updated, column.semanticRole);
    updated.normalized = normalized.value;
    return { ...row, cells: { ...row.cells, [columnId]: updated } };
  });
  const next: PlanningDataset = {
    ...dataset,
    snapshotRevision: null,
    dirty: dataset.mappingRevision === null || datasetDirty(rows, dataset.columns),
    rows,
  };
  return validateDataset(next);
}

export function restoreCell(
  dataset: PlanningDataset,
  rowId: string,
  columnId: string,
  cell: PlanningCell,
): PlanningDataset {
  const rows = dataset.rows.map((row) => row.id === rowId
    ? { ...row, cells: { ...row.cells, [columnId]: { ...cell } } }
    : row);
  return validateDataset({
    ...dataset,
    rows,
    dirty: dataset.mappingRevision === null || datasetDirty(rows, dataset.columns),
    snapshotRevision: null,
  });
}

export function markDatasetPersisted(dataset: PlanningDataset): PlanningDataset {
  const rows = dataset.rows.map((row) => ({
    ...row,
    cells: Object.fromEntries(Object.entries(row.cells).map(([columnId, cell]) => [
      columnId,
      { ...cell, acceptedRaw: cell.currentRaw },
    ])),
  }));
  return { ...dataset, rows, dirty: false };
}

export function markWorkbookPersisted(workbook: WorkbookState): WorkbookState {
  return { ...workbook, sheets: workbook.sheets.map(markDatasetPersisted) };
}

export function workbookHasUnsavedChanges(workbook: WorkbookState | null): boolean {
  return workbook?.sheets.some((sheet) => sheet.dirty) ?? false;
}

export function validateDataset(dataset: PlanningDataset): PlanningDataset {
  const issues: ValidationIssue[] = [];
  const add = (issue: Omit<ValidationIssue, 'id'>) => {
    const key = `${issue.code}\u0000${issue.rowId ?? ''}\u0000${issue.columnId ?? ''}\u0000${issue.message}`;
    issues.push({ ...issue, id: `issue-${stableHash(key)}` });
  };

  if (!dataset.sourceIdentity.trim()) {
    add({ severity: 'error', code: 'SOURCE_IDENTITY_MISSING', message: 'The dataset source identity is missing.' });
  }
  if (dataset.rows.length === 0) {
    add({ severity: 'error', code: 'NO_DATA_ROWS', message: 'The worksheet contains no planning rows.' });
  }

  if (!dataset.mappingsConfirmed) {
    add({ severity: 'warning', code: 'MAPPINGS_UNCONFIRMED', message: 'Review and confirm semantic mappings before relying on canonical values.' });
  }
  if (!dataset.grainColumnId || !dataset.grainConfirmed) {
    add({ severity: 'warning', code: 'GRAIN_UNCONFIRMED', message: 'Select and confirm the column that defines one planning record.' });
  }

  const roleOwners = new Map<string, PlanningColumn>();
  const headerOwners = new Map<string, PlanningColumn>();
  for (const column of dataset.columns) {
    if (!column.originalHeader.trim()) {
      add({ severity: 'warning', code: 'EMPTY_HEADER', message: `Source column ${column.sourceIndex + 1} has no label.`, columnId: column.id });
    }
    const normalizedHeader = column.originalHeader.trim().toLocaleLowerCase('en-US');
    if (headerOwners.has(normalizedHeader)) {
      add({ severity: 'warning', code: 'DUPLICATE_HEADER', message: `The label “${column.originalHeader || '(blank)'}” occurs more than once; column position preserves identity.`, columnId: column.id });
    } else {
      headerOwners.set(normalizedHeader, column);
    }
    if (column.semanticRole) {
      const existing = roleOwners.get(column.semanticRole);
      if (existing) {
        add({ severity: 'error', code: 'DUPLICATE_SEMANTIC_ROLE', message: `Only one column may map to ${column.semanticRole.replaceAll('_', ' ')}.`, columnId: column.id });
      } else {
        roleOwners.set(column.semanticRole, column);
      }
    }
  }

  if (dataset.grainColumnId) {
    const grainColumn = dataset.columns.find((column) => column.id === dataset.grainColumnId);
    if (!grainColumn) {
      add({ severity: 'error', code: 'GRAIN_COLUMN_MISSING', message: 'The selected dataset-grain column no longer exists.' });
    } else if (grainColumn.semanticRole !== 'planned_job_identifier' && grainColumn.semanticRole !== 'asset_identifier') {
      add({
        severity: 'error',
        code: 'INVALID_GRAIN_ROLE',
        message: 'Dataset grain must use a mapped planned-job or asset identifier column.',
        columnId: grainColumn.id,
      });
    }
  }

  const grainValues = new Map<string, string[]>();
  const normalizedRows = dataset.rows.map((row) => {
    const normalizedCells: Record<string, PlanningCell> = {};
    for (const column of dataset.columns) {
      const cell = row.cells[column.id];
      if (!cell) {
        add({ severity: 'error', code: 'MISSING_CELL', message: 'Row is missing a source-column value.', rowId: row.id, columnId: column.id });
        continue;
      }
      const normalized = normalizeForRole(cell, column.semanticRole);
      normalizedCells[column.id] = { ...cell, normalized: normalized.value };
      if (!normalized.valid) {
        add({ severity: 'error', code: 'INVALID_CANONICAL_VALUE', message: normalized.reason ?? 'Value is invalid.', rowId: row.id, columnId: column.id });
      }
      if (cell.formula) {
        add({ severity: 'warning', code: 'INERT_FORMULA', message: 'Formula was not executed; only an available cached scalar result is shown.', rowId: row.id, columnId: column.id });
      }
      if (cell.hyperlink) {
        add({ severity: 'warning', code: 'INERT_HYPERLINK', message: 'Hyperlink is preserved as provenance but is not activated.', rowId: row.id, columnId: column.id });
      }
    }
    if (dataset.grainColumnId) {
      const raw = normalizedCells[dataset.grainColumnId]?.currentRaw;
      const identity = raw === null || raw === undefined ? '' : String(raw).trim();
      if (!identity) {
        add({ severity: 'error', code: 'MISSING_GRAIN_VALUE', message: 'The dataset-grain value is missing.', rowId: row.id, columnId: dataset.grainColumnId });
      } else {
        grainValues.set(identity, [...(grainValues.get(identity) ?? []), row.id]);
      }
    }
    return { ...row, cells: normalizedCells };
  });

  if (dataset.grainColumnId) {
    for (const [identity, rowIds] of grainValues) {
      if (rowIds.length < 2) continue;
      for (const rowId of rowIds) {
        add({
          severity: 'error',
          code: 'DUPLICATE_GRAIN_VALUE',
          message: `Duplicate dataset identity “${identity}”.`,
          rowId,
          columnId: dataset.grainColumnId,
        });
      }
    }
  }

  const rows = normalizedRows.map((row) => {
    const rowIssues = issues.filter((issue) => issue.rowId === row.id);
    const readiness = rowIssues.some((issue) => issue.severity === 'error')
      ? 'INVALID'
      : rowIssues.some((issue) => issue.severity === 'warning')
        ? 'REVIEW_REQUIRED'
        : 'READY';
    return { ...row, readiness } as PlanningRow;
  });
  const mappingRequired = !dataset.mappingsConfirmed || !dataset.grainConfirmed;
  const readyRows = rows.filter((row) => row.readiness === 'READY').length;
  const hasErrors = issues.some((issue) => issue.severity === 'error');
  const hasReviewRows = rows.some((row) => row.readiness === 'REVIEW_REQUIRED');
  const readiness = mappingRequired
    ? 'MAPPING_REQUIRED'
    : hasErrors || hasReviewRows
      ? readyRows > 0 ? 'PARTIALLY_READY' : 'BLOCKED'
      : 'READY';

  return { ...dataset, rows, issues, readiness };
}

export function issueCounts(dataset: PlanningDataset): Record<'error' | 'warning' | 'info', number> {
  return dataset.issues.reduce(
    (counts, issue) => ({ ...counts, [issue.severity]: counts[issue.severity] + 1 }),
    { error: 0, warning: 0, info: 0 },
  );
}
