import type { PlanningDataset, SemanticRole, WorkbookState } from './planning';

export type DecisionObjective = 'JOB_REPLACEMENT' | 'GROUP_REPLACEMENT' | 'PRIORITIZATION' | 'PORTFOLIO';
export type ScopeMode = 'ALL_RECORDS' | 'ALL_VALID' | 'ALL_ELIGIBLE' | 'FILTERED' | 'MANUAL' | 'SAVED_VIEW' | 'FILTERED_MANUAL';
export type CandidateState =
  | 'OUTSIDE_SCOPE'
  | 'INVALID'
  | 'INELIGIBLE'
  | 'INFEASIBLE'
  | 'REVIEW_REQUIRED'
  | 'EXCLUDED'
  | 'ELIGIBLE';

export interface DecisionContext {
  schemaVersion: '1.0';
  id: string;
  objective: DecisionObjective;
  datasetId: string;
  datasetSnapshotRevision: string;
  mappingRevision: string;
  targetRowIds: string[];
  targetAssetId: string | null;
  effectiveDate: string;
  createdAt: string;
}

export interface ScopeFilter {
  role: SemanticRole;
  operator: 'EQUALS' | 'NOT_EQUALS' | 'CONTAINS';
  value: string;
}

export interface CandidateScope {
  schemaVersion: '1.0';
  id: string;
  revision: string;
  datasetId: string;
  datasetSnapshotRevision: string;
  decisionContextId: string;
  mode: ScopeMode;
  candidateRowIds: string[];
  filters: ScopeFilter[];
  manualIncludedRowIds: string[];
  manualExcludedRowIds: string[];
  savedViewId: string | null;
  rationale: string;
  createdAt: string;
  checksum: string;
}

export type EligibilityOperator =
  | 'PRESENT'
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'CONTAINS'
  | 'LTE'
  | 'GTE'
  | 'ON_OR_BEFORE';

export interface EligibilityRule {
  id: string;
  label: string;
  role: SemanticRole;
  operator: EligibilityOperator;
  value: string | number | null;
  missingBehavior: 'REVIEW_REQUIRED' | 'INELIGIBLE';
  failureState: 'INELIGIBLE' | 'INFEASIBLE';
  enabled: boolean;
}

export interface EligibilityRuleSet {
  schemaVersion: '1.0';
  id: string;
  revision: string;
  name: string;
  rules: EligibilityRule[];
  checksum: string;
}

export interface RuleEvidence {
  ruleId: string;
  ruleLabel: string;
  role: SemanticRole;
  sourceValue: string | number | boolean | null;
  passed: boolean | null;
  reason: string;
}

export interface CandidateEvaluation {
  rowId: string;
  state: CandidateState;
  reasons: string[];
  evidence: RuleEvidence[];
}

export interface EligibilityRun {
  schemaVersion: '1.0';
  id: string;
  decisionContextId: string;
  datasetSnapshotRevision: string;
  scopeRevision: string;
  ruleSetRevision: string;
  evaluations: CandidateEvaluation[];
  createdAt: string;
  checksum: string;
}

export interface PriorityListEntry {
  itemId: string;
  priorityRank: number | null;
  sourceRow: number;
  rawItemId: string | number | boolean | null;
  rawPriorityRank: string | number | boolean | null;
  status: 'VALID' | 'INVALID';
  issues: string[];
  additionalFields: Record<string, string | number | boolean | null>;
}

export interface PriorityListRevision {
  schemaVersion: '2.0';
  /** Stable logical list identity. It is deliberately independent of revision content. */
  id: string;
  /** Immutable SHA-256 identity for this exact list revision. */
  revision: string;
  name: string;
  identifierHeader: string;
  rankHeader: string;
  entries: PriorityListEntry[];
  issues: string[];
  sourceName: string;
  createdAt: string;
  checksum: string;
}

export type RankingSourceType = 'PRIORITY_LIST' | 'REFERENCE' | 'DEMONSTRATION_MODEL';

export interface RankingSourceIdentity {
  type: RankingSourceType;
  id: string;
  revision: string;
  label: string;
  scoreMeaning: string;
  limitations: string[];
}

export interface ScoreContribution {
  feature: string;
  input: number;
  contribution: number;
  explanation: string;
}

export interface CandidateRank {
  rowId: string;
  score: number | null;
  rank: number | null;
  contributions: ScoreContribution[];
  explanation: string[];
}

export interface RankingResult {
  schemaVersion: '1.0';
  id: string;
  contextId: string;
  datasetSnapshotRevision: string;
  scopeRevision: string;
  eligibilityRunId: string | null;
  candidateRowIds: string[];
  source: RankingSourceIdentity;
  ranks: CandidateRank[];
  createdAt: string;
  checksum: string;
}

export interface RankingComparison {
  populationRowIds: string[];
  sourceIds: string[];
  topK: number;
  topKOverlap: number;
  rankDifferences: Record<string, Record<string, number | null>>;
  limitations: string[];
}

export interface HumanRank {
  rowId: string;
  myRank: number;
}

export interface PortfolioConstraint {
  budget: number;
  resourceCapacities: Record<string, number>;
}

export interface PortfolioCandidate {
  rowId: string;
  value: number;
  cost: number;
  resourceRequirements: Record<string, number>;
}

export interface PortfolioResult {
  schemaVersion: '2.0';
  id: string;
  contextId: string;
  datasetSnapshotRevision: string;
  selectedRowIds: string[];
  excluded: Array<{ rowId: string; reason: string }>;
  totalCost: number;
  totalValue: number;
  resourceUse: Record<string, number>;
  constraint: PortfolioConstraint;
  candidates: PortfolioCandidate[];
  objectiveRankingResultId: string | null;
  method: 'EXACT' | 'BOUNDED_GREEDY';
  globallyOptimal: boolean;
  createdAt: string;
  checksum: string;
}

export type HumanEventType = 'MY_RANK_SAVED' | 'DECISION_RECORDED' | 'FEEDBACK_RECORDED' | 'OUTCOME_RECORDED' | 'EVIDENCE_CORRECTED';

export interface HumanEvent {
  id: string;
  type: HumanEventType;
  occurredAt: string;
  actorLabel: string;
  rowId: string | null;
  value: string;
  reason: string;
  supersedesEventId: string | null;
}

export interface CaseSnapshot {
  workbook: WorkbookState;
  dataset: PlanningDataset;
  context: DecisionContext;
  scope: CandidateScope;
  ruleSet: EligibilityRuleSet | null;
  eligibility: EligibilityRun | null;
  rankings: RankingResult[];
  myRank: HumanRank[];
  portfolio: PortfolioResult | null;
  relationships: RelationshipRecord[];
  historicalEvents: HistoricalEventRecord[];
}

export interface PlanningCase {
  schemaVersion: '1.0' | '2.0';
  id: string;
  revision: string;
  name: string;
  createdAt: string;
  snapshot: CaseSnapshot;
  events: HumanEvent[];
  parentCaseId: string | null;
  parentScenarioId: string | null;
  checksum: string;
}

export interface ScenarioRecord {
  schemaVersion: '2.0';
  id: string;
  parentCaseId: string;
  parentCaseRevision: string;
  name: string;
  createdAt: string;
  overrides: {
    candidateRowIds?: string[];
    budget?: number;
    rankingResultId?: string;
    notes?: string;
  };
  status: 'EVALUATED' | 'UNEVALUATED';
  resultCaseId: string | null;
  resultSummary: string;
  checksum: string;
}

export interface SavedWorkspace {
  id: string;
  name: string;
  workbook: WorkbookState;
  savedAt: string;
}

export interface SavedPlanningView {
  id: string;
  name: string;
  datasetId: string;
  filters: ScopeFilter[];
  createdAt: string;
}

export interface DecisionDraft {
  workspaceId: string;
  context: DecisionContext | null;
  scope: CandidateScope | null;
  ruleSet: EligibilityRuleSet | null;
  eligibility: EligibilityRun | null;
  rankings: RankingResult[];
  activeRankingId: string | null;
  myRank: HumanRank[];
  portfolio: PortfolioResult | null;
  updatedAt: string;
}

export interface PersistedApplicationState {
  schemaVersion: '2.0';
  workspaces: SavedWorkspace[];
  activeWorkspaceId: string | null;
  priorityLists: PriorityListRevision[];
  cases: PlanningCase[];
  scenarios: ScenarioRecord[];
  savedViews: SavedPlanningView[];
  decisionDrafts: DecisionDraft[];
  relationships: RelationshipRecord[];
  historicalEvents: HistoricalEventRecord[];
  lastCommittedAt: string | null;
}

export interface RelationshipRecord {
  relationshipId: string;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  provenance: { kind: 'SYNTHETIC' | 'IMPORTED' | 'USER_ENTERED' | 'OBSERVED'; source: string };
}

export interface HistoricalEventRecord {
  eventId: string;
  entityId: string;
  eventType: string;
  occurredAt: string;
  value: string;
  provenance: { kind: 'SYNTHETIC' | 'IMPORTED' | 'USER_ENTERED' | 'OBSERVED'; source: string };
}
