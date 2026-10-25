export type CellScalar = string | number | boolean | null;

export type SourceCellType =
  | 'blank'
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'formula'
  | 'hyperlink'
  | 'error'
  | 'unknown';

export type ProvenanceKind = 'SYNTHETIC' | 'IMPORTED' | 'EXTERNAL_IMPORTED' | 'USER_ENTERED' | 'DERIVED';

export type RowReadiness = 'READY' | 'REVIEW_REQUIRED' | 'INVALID';
export type DatasetReadiness = 'MAPPING_REQUIRED' | 'BLOCKED' | 'PARTIALLY_READY' | 'READY';

export type SemanticRole =
  | 'asset_identifier'
  | 'operational_area'
  | 'planned_job_identifier'
  | 'job_description'
  | 'job_category'
  | 'priority'
  | 'estimated_cost'
  | 'estimated_duration'
  | 'resource_requirement'
  | 'planned_date'
  | 'status';

export type MappingState = 'unmapped' | 'suggested' | 'user_selected' | 'confirmed';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface SourceProvenance {
  kind: ProvenanceKind;
  sourceName: string;
  sheetName: string;
  sourceRow: number;
  sourceColumn: number;
  importedAt?: string;
}

export interface PlanningCell {
  originalRaw: CellScalar;
  currentRaw: CellScalar;
  acceptedRaw: CellScalar;
  normalized: CellScalar;
  sourceType: SourceCellType;
  provenance: SourceProvenance;
  originalProvenance: SourceProvenance;
  modified: boolean;
  formula?: string;
  hyperlink?: string;
}

export interface PlanningColumn {
  id: string;
  originalHeader: string;
  sourceIndex: number;
  duplicateOrdinal: number;
  semanticRole: SemanticRole | null;
  suggestedRole: SemanticRole | null;
  mappingState: MappingState;
}

export interface PlanningRow {
  id: string;
  sourceRow: number;
  cells: Record<string, PlanningCell>;
  readiness: RowReadiness;
}

export interface ValidationIssue {
  id: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  rowId?: string;
  columnId?: string;
}

export interface PlanningDataset {
  contractVersion: '1.1';
  id: string;
  sourceIdentity: string;
  snapshotRevision: string | null;
  mappingRevision: string | null;
  name: string;
  sourceName: string;
  sheetName: string;
  synthetic: boolean;
  columns: PlanningColumn[];
  rows: PlanningRow[];
  grainColumnId: string | null;
  grainConfirmed: boolean;
  mappingsConfirmed: boolean;
  readiness: DatasetReadiness;
  dirty: boolean;
  issues: ValidationIssue[];
}

export interface WorkbookState {
  sourceName: string;
  sourceIdentity: string;
  sheets: PlanningDataset[];
  activeSheetIndex: number;
}

export interface SourceCellInput {
  value: CellScalar;
  type?: SourceCellType;
  formula?: string;
  hyperlink?: string;
}

export interface SourceTable {
  sourceName: string;
  sourceIdentity?: string;
  sheetName: string;
  synthetic: boolean;
  headers: string[];
  rows: Array<Array<CellScalar | SourceCellInput>>;
}

export const SEMANTIC_ROLE_DEFINITIONS: ReadonlyArray<{
  id: SemanticRole;
  label: string;
  canonicalType: 'text' | 'number' | 'date';
}> = [
  { id: 'asset_identifier', label: 'Asset identifier', canonicalType: 'text' },
  { id: 'operational_area', label: 'Operational area', canonicalType: 'text' },
  { id: 'planned_job_identifier', label: 'Planned job identifier', canonicalType: 'text' },
  { id: 'job_description', label: 'Job description', canonicalType: 'text' },
  { id: 'job_category', label: 'Job category', canonicalType: 'text' },
  { id: 'priority', label: 'Priority', canonicalType: 'text' },
  { id: 'estimated_cost', label: 'Estimated cost', canonicalType: 'number' },
  { id: 'estimated_duration', label: 'Estimated duration', canonicalType: 'number' },
  { id: 'resource_requirement', label: 'Resource requirement', canonicalType: 'text' },
  { id: 'planned_date', label: 'Planned date', canonicalType: 'date' },
  { id: 'status', label: 'Status', canonicalType: 'text' },
];
