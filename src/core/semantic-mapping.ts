import type { PlanningDataset, SemanticRole } from '../contracts';
import { normalizeIdentityText } from './stable-identity';

const ALIASES: Readonly<Record<SemanticRole, ReadonlyArray<string>>> = {
  asset_identifier: ['asset', 'asset-id', 'asset-identifier', 'equipment-id', 'equipment'],
  operational_area: ['area', 'operational-area', 'location', 'site', 'work-area'],
  planned_job_identifier: ['job-id', 'planned-job-id', 'planned-job-identifier', 'work-order', 'work-order-id'],
  job_description: ['description', 'job-description', 'work-description', 'scope'],
  job_category: ['category', 'job-category', 'work-type', 'maintenance-type'],
  priority: ['priority', 'priority-code', 'criticality'],
  estimated_cost: ['cost', 'estimated-cost', 'budget', 'estimated-budget'],
  estimated_duration: ['duration', 'estimated-duration', 'duration-hours', 'estimated-hours'],
  resource_requirement: ['resource', 'resources', 'resource-requirement', 'crew', 'crew-type'],
  planned_date: ['date', 'planned-date', 'scheduled-date', 'start-date'],
  status: ['status', 'job-status', 'state'],
};

export function suggestSemanticRole(header: string): SemanticRole | null {
  const normalized = normalizeIdentityText(header);
  for (const [role, aliases] of Object.entries(ALIASES) as Array<[SemanticRole, ReadonlyArray<string>]>) {
    if (aliases.includes(normalized)) return role;
  }
  return null;
}

export function setColumnRole(
  dataset: PlanningDataset,
  columnId: string,
  role: SemanticRole | null,
): PlanningDataset {
  return {
    ...dataset,
    dirty: true,
    mappingRevision: null,
    snapshotRevision: null,
    mappingsConfirmed: false,
    grainConfirmed: false,
    columns: dataset.columns.map((column) =>
      column.id === columnId
        ? { ...column, semanticRole: role, mappingState: role ? 'user_selected' : 'unmapped' }
        : column,
    ),
  };
}

export function setDatasetGrain(dataset: PlanningDataset, columnId: string | null): PlanningDataset {
  return {
    ...dataset,
    grainColumnId: columnId,
    grainConfirmed: false,
    mappingsConfirmed: false,
    dirty: true,
    mappingRevision: null,
    snapshotRevision: null,
  };
}

export function confirmMappings(dataset: PlanningDataset): PlanningDataset {
  const roles = dataset.columns.map((column) => column.semanticRole).filter((role) => role !== null);
  const grainColumn = dataset.columns.find((column) => column.id === dataset.grainColumnId);
  const invalidGrain = !grainColumn ||
    (grainColumn.semanticRole !== 'planned_job_identifier' && grainColumn.semanticRole !== 'asset_identifier');
  if (!dataset.sourceIdentity.trim() || new Set(roles).size !== roles.length || invalidGrain) {
    return { ...dataset, mappingsConfirmed: false, grainConfirmed: false };
  }
  return {
    ...dataset,
    mappingsConfirmed: true,
    grainConfirmed: true,
    dirty: true,
    mappingRevision: null,
    snapshotRevision: null,
    columns: dataset.columns.map((column) => ({
      ...column,
      mappingState: column.semanticRole ? 'confirmed' : 'unmapped',
    })),
  };
}
