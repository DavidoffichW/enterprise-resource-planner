import type {
  CandidateRank,
  CandidateScope,
  EligibilityRun,
  HumanRank,
  PlanningDataset,
  PriorityListEntry,
  PriorityListRevision,
  RankingComparison,
  RankingResult,
  RankingSourceIdentity,
  ScoreContribution,
  SemanticRole,
} from '../contracts';
import { canonicalDigest } from './revision';
import { semanticValue } from './decision';

export const DEMONSTRATION_MODEL_SPEC = {
  schema: 'erp-synthetic-linear-ranker/1',
  id: 'synthetic-maintenance-linear-ranker',
  trainingRecipe: 'seeded-independent-synthetic-scenarios/1',
  split: 'scenario-group holdout',
  features: ['priority', 'estimated_cost', 'estimated_duration'] as const,
  coefficients: { intercept: 0.25, priority: 1.15, cost: -0.000035, duration: -0.045 },
  scoreMeaning: 'Synthetic demonstration ordering signal; not probability, confidence, accuracy, or expected benefit.',
  limitations: [
    'Independently authored synthetic demonstration model.',
    'Not trained or validated on operational outcomes.',
    'Only declared priority, estimated cost, and estimated duration inputs are consumed.',
  ],
} as const;

function priorityNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value ?? '').trim().match(/^(?:P|Priority\s*)?(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function compareNullableRanks(left: CandidateRank, right: CandidateRank, direction: 'asc' | 'desc' = 'asc'): number {
  if (left.rank === null && right.rank === null) return left.rowId.localeCompare(right.rowId);
  if (left.rank === null) return 1;
  if (right.rank === null) return -1;
  const difference = direction === 'asc' ? left.rank - right.rank : right.rank - left.rank;
  return difference || left.rowId.localeCompare(right.rowId);
}

function stableRanks(rows: Array<{ rowId: string; score: number | null; contributions: ScoreContribution[]; explanation: string[] }>): CandidateRank[] {
  const ranked = rows.filter((row): row is typeof row & { score: number } => row.score !== null)
    .sort((left, right) => right.score - left.score || left.rowId.localeCompare(right.rowId))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const unranked = rows.filter((row) => row.score === null)
    .sort((left, right) => left.rowId.localeCompare(right.rowId))
    .map((row) => ({ ...row, rank: null }));
  return [...ranked, ...unranked];
}

async function rankingResult(
  dataset: PlanningDataset,
  contextId: string,
  scope: CandidateScope,
  eligibility: EligibilityRun | null,
  source: RankingSourceIdentity,
  ranks: CandidateRank[],
  now = new Date().toISOString(),
): Promise<RankingResult> {
  if (!dataset.snapshotRevision || dataset.snapshotRevision !== scope.datasetSnapshotRevision) {
    throw new Error('Ranking requires the exact dataset snapshot materialized by Candidate Scope.');
  }
  if (eligibility && (eligibility.datasetSnapshotRevision !== dataset.snapshotRevision || eligibility.scopeRevision !== scope.revision)) {
    throw new Error('Advisory eligibility evidence does not match the ranking population.');
  }
  const candidateRowIds = [...scope.candidateRowIds];
  const rankIds = ranks.map((rank) => rank.rowId);
  if (rankIds.length !== candidateRowIds.length || rankIds.some((id) => !candidateRowIds.includes(id))) {
    throw new Error('Ranking source did not preserve the eligible candidate population.');
  }
  if (ranks.some((rank) => rank.score !== null && !Number.isFinite(rank.score))) throw new Error('Ranking source produced a non-finite score.');
  const body = {
    schemaVersion: '1.0' as const,
    contextId,
    datasetSnapshotRevision: dataset.snapshotRevision,
    scopeRevision: scope.revision,
    eligibilityRunId: eligibility?.id ?? null,
    candidateRowIds,
    source,
    ranks,
  };
  const checksum = await canonicalDigest({ schema: 'erp-ranking-result/1', ...body });
  return { ...body, id: `ranking-${checksum.slice(7, 23)}`, createdAt: now, checksum };
}

export async function createPriorityListRevision(
  name: string,
  identifierHeader: string,
  rankHeader: string,
  entries: Array<Pick<PriorityListEntry, 'itemId' | 'priorityRank' | 'additionalFields'> & Partial<Omit<PriorityListEntry, 'itemId' | 'priorityRank' | 'additionalFields'>>>,
  sourceName: string,
  now = new Date().toISOString(),
  logicalListId?: string,
): Promise<PriorityListRevision> {
  if (!name.trim() || !identifierHeader.trim() || !rankHeader.trim()) throw new Error('Priority List name and mapped columns are required.');
  const normalized = entries.map((entry, index): PriorityListEntry => ({
    itemId: String(entry.itemId ?? '').trim(),
    priorityRank: typeof entry.priorityRank === 'number' && Number.isSafeInteger(entry.priorityRank) && entry.priorityRank > 0 ? entry.priorityRank : null,
    sourceRow: entry.sourceRow ?? index + 2,
    rawItemId: entry.rawItemId ?? entry.itemId ?? null,
    rawPriorityRank: entry.rawPriorityRank ?? entry.priorityRank ?? null,
    status: 'VALID',
    issues: [],
    additionalFields: { ...entry.additionalFields },
  }));
  const itemRows = new Map<string, number[]>();
  const rankRows = new Map<number, number[]>();
  normalized.forEach((entry, index) => {
    if (entry.itemId) itemRows.set(entry.itemId, [...(itemRows.get(entry.itemId) ?? []), index]);
    if (entry.priorityRank !== null) rankRows.set(entry.priorityRank, [...(rankRows.get(entry.priorityRank) ?? []), index]);
  });
  normalized.forEach((entry, index) => {
    const issues: string[] = [];
    if (!entry.itemId) issues.push('Missing item identifier.');
    if (entry.priorityRank === null) issues.push('Priority Rank must be a positive integer.');
    if (entry.itemId && (itemRows.get(entry.itemId)?.length ?? 0) > 1) issues.push(`Duplicate item identifier “${entry.itemId}”.`);
    if (entry.priorityRank !== null && (rankRows.get(entry.priorityRank)?.length ?? 0) > 1) issues.push(`Duplicate Priority Rank ${entry.priorityRank}.`);
    normalized[index] = { ...entry, issues, status: issues.length ? 'INVALID' : 'VALID' };
  });
  const ordered = [...normalized].sort((left, right) => {
    if (left.priorityRank === null && right.priorityRank === null) return left.sourceRow - right.sourceRow;
    if (left.priorityRank === null) return 1;
    if (right.priorityRank === null) return -1;
    return left.priorityRank - right.priorityRank || left.sourceRow - right.sourceRow;
  });
  const issues = ordered.flatMap((entry) => entry.issues.map((issue) => `Row ${entry.sourceRow}: ${issue}`));
  const identityDigest = await canonicalDigest({ schema: 'erp-priority-list-identity/1', name: name.trim(), identifierHeader, rankHeader, sourceName });
  const id = logicalListId ?? `priority-list-${identityDigest.slice(7, 23)}`;
  const body = { schemaVersion: '2.0' as const, id, name: name.trim(), identifierHeader, rankHeader, entries: ordered, issues, sourceName };
  const checksum = await canonicalDigest({ schema: 'erp-priority-list-revision/2', ...body });
  return { ...body, revision: checksum, createdAt: now, checksum };
}

export async function rankByPriorityList(
  dataset: PlanningDataset,
  contextId: string,
  scope: CandidateScope,
  eligibility: EligibilityRun | null,
  list: PriorityListRevision,
): Promise<RankingResult> {
  if (!dataset.grainColumnId) throw new Error('Priority List matching requires a dataset grain.');
  const lookup = new Map(list.entries.filter((entry) => entry.status === 'VALID' && entry.priorityRank !== null).map((entry) => [entry.itemId, entry.priorityRank]));
  const ranks: CandidateRank[] = scope.candidateRowIds.map((rowId) => {
    const row = dataset.rows.find((candidate) => candidate.id === rowId)!;
    const itemId = String(row.cells[dataset.grainColumnId!]?.normalized ?? '');
    const priorityRank = lookup.get(itemId) ?? null;
    return {
      rowId,
      score: priorityRank === null ? null : -priorityRank,
      rank: priorityRank,
      contributions: [],
      explanation: priorityRank === null
        ? [`No entry for item “${itemId}” in Priority List ${list.name}.`]
        : [`Priority Rank ${priorityRank} from immutable list revision ${list.revision}.`],
    };
  });
  const matched = ranks.filter((rank) => rank.rank !== null).sort((a, b) => a.rank! - b.rank! || a.rowId.localeCompare(b.rowId));
  const unmatched = ranks.filter((rank) => rank.rank === null).sort((a, b) => a.rowId.localeCompare(b.rowId));
  const normalized = [...matched, ...unmatched];
  const source: RankingSourceIdentity = {
    type: 'PRIORITY_LIST', id: list.id, revision: list.revision, label: list.name,
    scoreMeaning: 'Explicit reusable Priority Rank; row order is not inferred.',
    limitations: ['Items absent from the selected list remain unranked.'],
  };
  return rankingResult(dataset, contextId, scope, eligibility, source, normalized);
}

function contribution(feature: string, input: number, coefficient: number): ScoreContribution {
  const value = input * coefficient;
  return { feature, input, contribution: value, explanation: `${feature} ${input} × coefficient ${coefficient} = ${value.toFixed(4)}.` };
}

export async function rankByWeightedCriteria(
  dataset: PlanningDataset,
  contextId: string,
  scope: CandidateScope,
  eligibility: EligibilityRun | null,
): Promise<RankingResult> {
  const scored = scope.candidateRowIds.map((rowId) => {
    const priority = priorityNumber(semanticValue(dataset, rowId, 'priority'));
    const cost = finiteNumber(semanticValue(dataset, rowId, 'estimated_cost'));
    const duration = finiteNumber(semanticValue(dataset, rowId, 'estimated_duration'));
    if (priority === null || cost === null || duration === null) return { rowId, score: null, contributions: [], explanation: ['Unranked: one or more declared weighted-ranking inputs are missing or invalid.'] };
    const parts = [
      contribution('priority inverse', 6 - Math.min(Math.max(priority, 1), 5), 2),
      contribution('estimated cost', cost, -0.00005),
      contribution('estimated duration', duration, -0.05),
    ];
    return { rowId, score: parts.reduce((sum, part) => sum + part.contribution, 0), contributions: parts, explanation: parts.map((part) => part.explanation) };
  });
  const source: RankingSourceIdentity = {
    type: 'REFERENCE', id: 'weighted-criteria-reference', revision: 'weighted-criteria/1',
    label: 'Transparent weighted criteria', scoreMeaning: 'Deterministic ordering utility; higher is preferred.',
    limitations: ['Weights are public demonstration settings and are not domain policy.'],
  };
  return rankingResult(dataset, contextId, scope, eligibility, source, stableRanks(scored));
}

export async function demonstrationModelIdentity(): Promise<RankingSourceIdentity> {
  const revision = await canonicalDigest(DEMONSTRATION_MODEL_SPEC);
  return {
    type: 'DEMONSTRATION_MODEL', id: DEMONSTRATION_MODEL_SPEC.id, revision,
    label: 'Synthetic linear demonstration model', scoreMeaning: DEMONSTRATION_MODEL_SPEC.scoreMeaning,
    limitations: [...DEMONSTRATION_MODEL_SPEC.limitations],
  };
}

export async function rankByDemonstrationModel(
  dataset: PlanningDataset,
  contextId: string,
  scope: CandidateScope,
  eligibility: EligibilityRun | null,
): Promise<RankingResult> {
  const c = DEMONSTRATION_MODEL_SPEC.coefficients;
  const scored = scope.candidateRowIds.map((rowId) => {
    const priority = priorityNumber(semanticValue(dataset, rowId, 'priority'));
    const cost = finiteNumber(semanticValue(dataset, rowId, 'estimated_cost'));
    const duration = finiteNumber(semanticValue(dataset, rowId, 'estimated_duration'));
    if (priority === null || cost === null || duration === null) return { rowId, score: null, contributions: [], explanation: ['Unranked: one or more admitted demonstration-model features are missing or invalid.'] };
    const parts = [
      contribution('intercept', 1, c.intercept),
      contribution('priority inverse', 6 - Math.min(Math.max(priority, 1), 5), c.priority),
      contribution('estimated cost', cost, c.cost),
      contribution('estimated duration', duration, c.duration),
    ];
    return { rowId, score: parts.reduce((sum, part) => sum + part.contribution, 0), contributions: parts, explanation: parts.map((part) => part.explanation) };
  });
  return rankingResult(dataset, contextId, scope, eligibility, await demonstrationModelIdentity(), stableRanks(scored));
}

export function compareRankings(results: RankingResult[], topK = 5): RankingComparison {
  if (results.length < 2) throw new Error('Model Comparison requires at least two ranking results.');
  const population = results[0].candidateRowIds;
  for (const result of results.slice(1)) {
    if (result.datasetSnapshotRevision !== results[0].datasetSnapshotRevision ||
        result.contextId !== results[0].contextId || result.scopeRevision !== results[0].scopeRevision ||
        result.eligibilityRunId !== results[0].eligibilityRunId ||
        result.candidateRowIds.length !== population.length || result.candidateRowIds.some((id, index) => id !== population[index])) {
      throw new Error('Ranking populations or decision contexts are incompatible.');
    }
  }
  const k = Math.max(1, Math.min(topK, population.length));
  const topSets = results.map((result) => new Set(result.ranks.filter((rank) => rank.rank !== null).sort((a, b) => a.rank! - b.rank!).slice(0, k).map((rank) => rank.rowId)));
  const intersection = [...topSets[0]].filter((id) => topSets.every((set) => set.has(id))).length;
  const rankDifferences: RankingComparison['rankDifferences'] = {};
  for (const rowId of population) {
    rankDifferences[rowId] = Object.fromEntries(results.map((result) => [result.source.id, result.ranks.find((rank) => rank.rowId === rowId)?.rank ?? null]));
  }
  return {
    populationRowIds: [...population], sourceIds: results.map((result) => result.source.id), topK: k,
    topKOverlap: k === 0 ? 0 : intersection / k, rankDifferences,
    limitations: ['Overlap describes agreement between ranking sources; it is not predictive accuracy or operational effectiveness.'],
  };
}

export function validateHumanRank(ranks: HumanRank[], eligibleRowIds: string[]): HumanRank[] {
  if (ranks.length !== eligibleRowIds.length || new Set(ranks.map((rank) => rank.rowId)).size !== eligibleRowIds.length ||
      ranks.some((rank) => !eligibleRowIds.includes(rank.rowId)) ||
      new Set(ranks.map((rank) => rank.myRank)).size !== ranks.length ||
      ranks.some((rank) => !Number.isSafeInteger(rank.myRank) || rank.myRank < 1 || rank.myRank > ranks.length)) {
    throw new Error('My Rank must be a complete unique ordering of the eligible population.');
  }
  return [...ranks].sort((a, b) => a.myRank - b.myRank);
}
