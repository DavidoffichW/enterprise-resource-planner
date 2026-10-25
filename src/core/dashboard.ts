import type { CandidateEvaluation, PlanningCase, PlanningDataset, PortfolioResult, SemanticRole } from '../contracts';
import { semanticValue } from './decision';

export interface DashboardMetric {
  id: string;
  label: string;
  value: number;
  source: string;
  meaning: string;
}

export interface DashboardSummary {
  metrics: DashboardMetric[];
  statusDistribution: Array<{ label: string; count: number }>;
  priorityDistribution: Array<{ label: string; count: number }>;
  eligibilityDistribution: Array<{ label: string; count: number }>;
  portfolioSelected: string[];
}

function distribution(dataset: PlanningDataset, role: SemanticRole) {
  const counts = new Map<string, number>();
  for (const row of dataset.rows) {
    const value = semanticValue(dataset, row.id, role);
    const key = value === null || value === '' ? 'Missing' : String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([label, count]) => ({ label, count }));
}

export function buildDashboard(
  dataset: PlanningDataset,
  evaluations: CandidateEvaluation[] = [],
  portfolio: PortfolioResult | null = null,
  cases: PlanningCase[] = [],
  relationshipCount = 0,
  historicalEventCount = 0,
): DashboardSummary {
  const costs = dataset.rows.map((row) => semanticValue(dataset, row.id, 'estimated_cost')).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const eligibility = new Map<string, number>();
  for (const evaluation of evaluations) eligibility.set(evaluation.state, (eligibility.get(evaluation.state) ?? 0) + 1);
  return {
    metrics: [
      { id: 'planned-count', label: 'Planned jobs', value: dataset.rows.length, source: `Dataset ${dataset.snapshotRevision ?? dataset.id}`, meaning: 'Count of preserved planning rows in the active worksheet.' },
      { id: 'total-cost', label: 'Total estimated cost', value: costs.reduce((sum, value) => sum + value, 0), source: 'Mapped estimated-cost values', meaning: 'Sum of valid mapped estimated cost; missing/invalid values are excluded, not treated as zero.' },
      { id: 'case-count', label: 'Recorded Cases', value: cases.length, source: 'Local immutable Case store', meaning: 'Count of locally committed historical Cases.' },
      { id: 'portfolio-count', label: 'Portfolio jobs', value: portfolio?.selectedRowIds.length ?? 0, source: portfolio?.id ?? 'No portfolio result', meaning: 'Count selected by the latest displayed portfolio result.' },
      { id: 'relationship-count', label: 'Relationships', value: relationshipCount, source: 'Local relationship evidence store', meaning: 'Stable relationship records available for effective-date filtering.' },
      { id: 'history-count', label: 'Historical events', value: historicalEventCount, source: 'Local historical evidence store', meaning: 'Observed/imported/synthetic events; a Case applies its explicit as-of cutoff.' },
    ],
    statusDistribution: distribution(dataset, 'status'),
    priorityDistribution: distribution(dataset, 'priority'),
    eligibilityDistribution: [...eligibility].map(([label, count]) => ({ label, count })),
    portfolioSelected: portfolio?.selectedRowIds ?? [],
  };
}
