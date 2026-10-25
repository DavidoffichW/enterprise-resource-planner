import type {
  CandidateEvaluation,
  CandidateScope,
  DecisionContext,
  DecisionObjective,
  EligibilityRule,
  EligibilityRuleSet,
  EligibilityRun,
  HistoricalEventRecord,
  PlanningDataset,
  RelationshipRecord,
  SavedPlanningView,
  ScopeFilter,
  ScopeMode,
  SemanticRole,
} from '../contracts';
import { canonicalDigest } from './revision';
import { stableHash } from './stable-identity';

function roleColumn(dataset: PlanningDataset, role: SemanticRole) {
  return dataset.columns.find((column) => column.semanticRole === role) ?? null;
}

export function semanticValue(dataset: PlanningDataset, rowId: string, role: SemanticRole) {
  const column = roleColumn(dataset, role);
  const row = dataset.rows.find((candidate) => candidate.id === rowId);
  return column && row ? row.cells[column.id]?.normalized ?? null : null;
}

export function semanticText(dataset: PlanningDataset, rowId: string, role: SemanticRole): string {
  const value = semanticValue(dataset, rowId, role);
  return value === null ? '' : String(value);
}

export function createDecisionContext(
  dataset: PlanningDataset,
  objective: DecisionObjective,
  targetRowIds: string[],
  effectiveDate: string,
  now = new Date().toISOString(),
): DecisionContext {
  if (!dataset.snapshotRevision || !dataset.mappingRevision) {
    throw new Error('Export or save the dataset to establish snapshot and mapping revisions before creating a decision context.');
  }
  const uniqueTargets = [...new Set(targetRowIds)];
  if (objective === 'JOB_REPLACEMENT' && uniqueTargets.length !== 1) {
    throw new Error('Job replacement requires exactly one planned item.');
  }
  if (objective === 'GROUP_REPLACEMENT' && uniqueTargets.length < 1) {
    throw new Error('Group replacement requires at least one planned item.');
  }
  if (uniqueTargets.some((id) => !dataset.rows.some((row) => row.id === id))) {
    throw new Error('A selected planned item does not exist in the active dataset.');
  }
  const targetAssets = uniqueTargets.map((id) => semanticText(dataset, id, 'asset_identifier')).filter(Boolean);
  return {
    schemaVersion: '1.0',
    id: `context-${stableHash(`${dataset.snapshotRevision}\u0000${objective}\u0000${uniqueTargets.join('\u0000')}\u0000${effectiveDate}`)}`,
    objective,
    datasetId: dataset.id,
    datasetSnapshotRevision: dataset.snapshotRevision,
    mappingRevision: dataset.mappingRevision,
    targetRowIds: uniqueTargets,
    targetAssetId: targetAssets.length === 1 ? targetAssets[0] : null,
    effectiveDate,
    createdAt: now,
  };
}

function filterRows(dataset: PlanningDataset, filters: ScopeFilter[]): string[] {
  return dataset.rows.filter((row) => filters.every((filter) => {
    const text = semanticText(dataset, row.id, filter.role).toLocaleLowerCase('en-US');
    const expected = filter.value.toLocaleLowerCase('en-US');
    if (filter.operator === 'EQUALS') return text === expected;
    if (filter.operator === 'NOT_EQUALS') return text !== expected;
    return text.includes(expected);
  })).map((row) => row.id);
}

export async function createCandidateScope(
  dataset: PlanningDataset,
  context: DecisionContext,
  options: {
    mode: ScopeMode;
    filters?: ScopeFilter[];
    manualIncludedRowIds?: string[];
    manualExcludedRowIds?: string[];
    savedView?: SavedPlanningView | null;
    eligibleRowIds?: string[];
    rationale?: string;
    now?: string;
  },
): Promise<CandidateScope> {
  if (!dataset.snapshotRevision || dataset.snapshotRevision !== context.datasetSnapshotRevision) {
    throw new Error('Candidate Scope requires the exact dataset snapshot used by the decision context.');
  }
  const filters = options.savedView?.filters ?? options.filters ?? [];
  const included = [...new Set(options.manualIncludedRowIds ?? [])];
  const excluded = new Set(options.manualExcludedRowIds ?? []);
  const validIds = new Set(dataset.rows.filter((row) => row.readiness === 'READY').map((row) => row.id));
  const allIds = new Set(dataset.rows.map((row) => row.id));
  const filtered = new Set(filterRows(dataset, filters));
  let selected: string[];
  if (options.mode === 'MANUAL') selected = included;
  else if (options.mode === 'FILTERED' || options.mode === 'SAVED_VIEW') selected = [...filtered];
  else if (options.mode === 'FILTERED_MANUAL') selected = [...new Set([...filtered, ...included])];
  else if (options.mode === 'ALL_ELIGIBLE' && options.eligibleRowIds) selected = options.eligibleRowIds;
  else if (options.mode === 'ALL_VALID') selected = [...validIds];
  else selected = [...allIds];

  selected = selected
    .filter((id) => allIds.has(id))
    .filter((id) => !excluded.has(id))
    .filter((id) => !context.targetRowIds.includes(id));
  const ordered = dataset.rows.map((row) => row.id).filter((id) => selected.includes(id));
  const createdAt = options.now ?? new Date().toISOString();
  const body = {
    schemaVersion: '1.0' as const,
    datasetId: dataset.id,
    datasetSnapshotRevision: dataset.snapshotRevision,
    decisionContextId: context.id,
    mode: options.mode,
    candidateRowIds: ordered,
    filters,
    manualIncludedRowIds: included,
    manualExcludedRowIds: [...excluded],
    savedViewId: options.savedView?.id ?? null,
    rationale: options.rationale ?? '',
  };
  const checksum = await canonicalDigest({ schema: 'erp-candidate-scope/1', ...body });
  return {
    ...body,
    id: `scope-${checksum.slice(7, 23)}`,
    revision: checksum,
    createdAt,
    checksum,
  };
}

export async function createRuleSet(name: string, rules: EligibilityRule[]): Promise<EligibilityRuleSet> {
  const normalized = rules.map((rule) => ({ ...rule }));
  const checksum = await canonicalDigest({ schema: 'erp-eligibility-rules/1', name, rules: normalized });
  return { schemaVersion: '1.0', id: `rules-${checksum.slice(7, 23)}`, revision: checksum, name, rules: normalized, checksum };
}

function compareRule(value: unknown, rule: EligibilityRule): boolean | null {
  if (value === null || value === undefined || value === '') return null;
  const expected = rule.value;
  if (rule.operator === 'PRESENT') return true;
  if (rule.operator === 'EQUALS') return String(value).toLocaleLowerCase('en-US') === String(expected).toLocaleLowerCase('en-US');
  if (rule.operator === 'NOT_EQUALS') return String(value).toLocaleLowerCase('en-US') !== String(expected).toLocaleLowerCase('en-US');
  if (rule.operator === 'CONTAINS') return String(value).toLocaleLowerCase('en-US').includes(String(expected).toLocaleLowerCase('en-US'));
  if (rule.operator === 'ON_OR_BEFORE') return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && String(value) <= String(expected);
  const number = typeof value === 'number' ? value : Number(value);
  const threshold = typeof expected === 'number' ? expected : Number(expected);
  if (!Number.isFinite(number) || !Number.isFinite(threshold)) return null;
  return rule.operator === 'LTE' ? number <= threshold : number >= threshold;
}

export async function evaluateEligibility(
  dataset: PlanningDataset,
  context: DecisionContext,
  scope: CandidateScope,
  ruleSet: EligibilityRuleSet,
  now = new Date().toISOString(),
): Promise<EligibilityRun> {
  if (dataset.snapshotRevision !== context.datasetSnapshotRevision || scope.datasetSnapshotRevision !== context.datasetSnapshotRevision) {
    throw new Error('Eligibility inputs do not share the decision dataset snapshot.');
  }
  const inScope = new Set(scope.candidateRowIds);
  const targetIds = new Set(context.targetRowIds);
  const evaluations: CandidateEvaluation[] = dataset.rows.map((row) => {
    if (targetIds.has(row.id)) return { rowId: row.id, state: 'EXCLUDED', reasons: ['Selected planned item is not a replacement candidate.'], evidence: [] };
    if (!inScope.has(row.id)) return { rowId: row.id, state: 'OUTSIDE_SCOPE', reasons: ['Not materialized in Candidate Scope.'], evidence: [] };
    if (row.readiness === 'INVALID') return { rowId: row.id, state: 'INVALID', reasons: ['Canonical planning row is invalid.'], evidence: [] };
    if (row.readiness === 'REVIEW_REQUIRED') return { rowId: row.id, state: 'REVIEW_REQUIRED', reasons: ['Canonical planning row requires review.'], evidence: [] };
    const evidence = ruleSet.rules.filter((rule) => rule.enabled).map((rule) => {
      const sourceValue = semanticValue(dataset, row.id, rule.role);
      const passed = compareRule(sourceValue, rule);
      return {
        ruleId: rule.id,
        ruleLabel: rule.label,
        role: rule.role,
        sourceValue,
        passed,
        reason: passed === true ? 'Rule passed.' : passed === null ? 'Required value is missing or invalid.' : 'Rule condition was not satisfied.',
      };
    });
    const missing = evidence.find((item) => item.passed === null);
    if (missing) {
      const rule = ruleSet.rules.find((candidate) => candidate.id === missing.ruleId)!;
      return {
        rowId: row.id,
        state: rule.missingBehavior,
        reasons: [missing.reason],
        evidence,
      };
    }
    const failed = evidence.find((item) => item.passed === false);
    if (failed) {
      const rule = ruleSet.rules.find((candidate) => candidate.id === failed.ruleId)!;
      return { rowId: row.id, state: rule.failureState, reasons: [`${failed.ruleLabel}: ${failed.reason}`], evidence };
    }
    return { rowId: row.id, state: 'ELIGIBLE', reasons: ['All enabled deterministic rules passed.'], evidence };
  });
  const body = {
    schemaVersion: '1.0' as const,
    decisionContextId: context.id,
    datasetSnapshotRevision: context.datasetSnapshotRevision,
    scopeRevision: scope.revision,
    ruleSetRevision: ruleSet.revision,
    evaluations,
  };
  const checksum = await canonicalDigest({ schema: 'erp-eligibility-run/1', ...body });
  return { ...body, id: `eligibility-${checksum.slice(7, 23)}`, createdAt: now, checksum };
}

export function defaultEligibilityRules(): EligibilityRule[] {
  return [
    { id: 'status-not-complete', label: 'Status is not complete', role: 'status', operator: 'NOT_EQUALS', value: 'Complete', missingBehavior: 'REVIEW_REQUIRED', failureState: 'INELIGIBLE', enabled: true },
    { id: 'cost-present', label: 'Estimated cost is available', role: 'estimated_cost', operator: 'PRESENT', value: null, missingBehavior: 'REVIEW_REQUIRED', failureState: 'INFEASIBLE', enabled: true },
    { id: 'duration-present', label: 'Estimated duration is available', role: 'estimated_duration', operator: 'PRESENT', value: null, missingBehavior: 'REVIEW_REQUIRED', failureState: 'INFEASIBLE', enabled: true },
    { id: 'resource-present', label: 'Resource requirement is available', role: 'resource_requirement', operator: 'PRESENT', value: null, missingBehavior: 'REVIEW_REQUIRED', failureState: 'INFEASIBLE', enabled: true },
    { id: 'planned-by-cutoff', label: 'Planned date is on or before the decision cutoff', role: 'planned_date', operator: 'ON_OR_BEFORE', value: '2028-12-31', missingBehavior: 'REVIEW_REQUIRED', failureState: 'INELIGIBLE', enabled: false },
    { id: 'maximum-cost', label: 'Estimated cost is within the configured maximum', role: 'estimated_cost', operator: 'LTE', value: 25000, missingBehavior: 'REVIEW_REQUIRED', failureState: 'INFEASIBLE', enabled: false },
  ];
}

export function validateRelationships(records: RelationshipRecord[]): string[] {
  const ids = new Set<string>();
  const issues: string[] = [];
  for (const record of records) {
    if (!record.relationshipId || ids.has(record.relationshipId)) issues.push(`Duplicate or missing relationship identity: ${record.relationshipId || '(missing)'}.`);
    if (!record.fromEntityId || !record.toEntityId) issues.push(`Relationship ${record.relationshipId} has an unresolved entity identity.`);
    if (record.effectiveFrom && record.effectiveTo && record.effectiveFrom > record.effectiveTo) issues.push(`Relationship ${record.relationshipId} has an invalid effective interval.`);
    ids.add(record.relationshipId);
  }
  return issues;
}

export function historicalEventsAtCutoff(events: HistoricalEventRecord[], cutoff: string): HistoricalEventRecord[] {
  const ids = new Set<string>();
  return events.filter((event) => {
    if (!event.eventId || ids.has(event.eventId)) throw new Error(`Historical event identity is missing or duplicated: ${event.eventId || '(missing)'}.`);
    ids.add(event.eventId);
    return event.occurredAt <= cutoff;
  });
}
