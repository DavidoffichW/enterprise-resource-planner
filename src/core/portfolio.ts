import type { PortfolioCandidate, PortfolioConstraint, PortfolioResult } from '../contracts';
import { canonicalDigest } from './revision';

function validCandidate(candidate: PortfolioCandidate): boolean {
  return Number.isFinite(candidate.value) && Number.isFinite(candidate.cost) && candidate.cost >= 0 &&
    Object.values(candidate.resourceRequirements).every((value) => Number.isFinite(value) && value >= 0);
}

function totals(selected: PortfolioCandidate[]) {
  const resourceUse: Record<string, number> = {};
  for (const candidate of selected) {
    for (const [resource, amount] of Object.entries(candidate.resourceRequirements)) {
      resourceUse[resource] = (resourceUse[resource] ?? 0) + amount;
    }
  }
  return {
    totalCost: selected.reduce((sum, candidate) => sum + candidate.cost, 0),
    totalValue: selected.reduce((sum, candidate) => sum + candidate.value, 0),
    resourceUse,
  };
}

function feasible(selected: PortfolioCandidate[], constraint: PortfolioConstraint): boolean {
  const result = totals(selected);
  return result.totalCost <= constraint.budget + Number.EPSILON &&
    Object.entries(result.resourceUse).every(([resource, used]) => used <= (constraint.resourceCapacities[resource] ?? 0) + Number.EPSILON);
}

function exactSelection(candidates: PortfolioCandidate[], constraint: PortfolioConstraint): PortfolioCandidate[] {
  let best: PortfolioCandidate[] = [];
  let bestValue = 0;
  let bestCost = 0;
  let bestKey = '';
  const ordered = [...candidates].sort((a, b) => a.rowId.localeCompare(b.rowId));
  const remainingPositiveValue = Array.from({length:ordered.length+1},()=>0);
  for (let index=ordered.length-1;index>=0;index-=1) remainingPositiveValue[index]=remainingPositiveValue[index+1]+Math.max(0,ordered[index].value);
  const visit = (index: number, selected: PortfolioCandidate[], cost: number, value: number, resources: Record<string,number>) => {
    if (value + remainingPositiveValue[index] < bestValue) return;
    if (index === ordered.length) {
      const key=selected.map((item)=>item.rowId).join('\u0000');
      if (value>bestValue || (value===bestValue && (cost<bestCost || (cost===bestCost && key<bestKey)))) {
        best=[...selected];bestValue=value;bestCost=cost;bestKey=key;
      }
      return;
    }
    visit(index + 1, selected, cost, value, resources);
    const candidate=ordered[index];
    const nextCost=cost+candidate.cost;
    if(nextCost>constraint.budget+Number.EPSILON)return;
    const nextResources={...resources};
    for(const [resource,amount] of Object.entries(candidate.resourceRequirements)){
      nextResources[resource]=(nextResources[resource]??0)+amount;
      if(nextResources[resource]>(constraint.resourceCapacities[resource]??0)+Number.EPSILON)return;
    }
    selected.push(candidate);
    visit(index + 1, selected, nextCost, value+candidate.value, nextResources);
    selected.pop();
  };
  visit(0, [], 0, 0, {});
  return best;
}

function boundedGreedy(candidates: PortfolioCandidate[], constraint: PortfolioConstraint): PortfolioCandidate[] {
  const ordered = [...candidates].sort((a, b) => {
    const aWeight = a.cost + Object.values(a.resourceRequirements).reduce((sum, value) => sum + value, 0);
    const bWeight = b.cost + Object.values(b.resourceRequirements).reduce((sum, value) => sum + value, 0);
    const densityDifference = (b.value / Math.max(bWeight, 1)) - (a.value / Math.max(aWeight, 1));
    return densityDifference || b.value - a.value || a.rowId.localeCompare(b.rowId);
  });
  const selected: PortfolioCandidate[] = [];
  for (const candidate of ordered) {
    if (feasible([...selected, candidate], constraint)) selected.push(candidate);
  }
  return selected;
}

export async function optimizePortfolio(
  contextId: string,
  datasetSnapshotRevision: string,
  candidates: PortfolioCandidate[],
  constraint: PortfolioConstraint,
  now = new Date().toISOString(),
  objectiveRankingResultId: string | null = null,
): Promise<PortfolioResult> {
  if (!Number.isFinite(constraint.budget) || constraint.budget < 0) throw new Error('Portfolio budget must be a non-negative finite number.');
  if (Object.values(constraint.resourceCapacities).some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Resource capacities must be non-negative finite numbers.');
  }
  if (new Set(candidates.map((candidate) => candidate.rowId)).size !== candidates.length || candidates.some((candidate) => !validCandidate(candidate))) {
    throw new Error('Portfolio candidates contain duplicate identities or invalid numeric inputs.');
  }
  const exact = candidates.length <= 20;
  const selected = exact ? exactSelection(candidates, constraint) : boundedGreedy(candidates, constraint);
  const selectedIds = new Set(selected.map((candidate) => candidate.rowId));
  const resultTotals = totals(selected);
  const excluded = candidates.filter((candidate) => !selectedIds.has(candidate.rowId)).map((candidate) => {
    const withCandidate = totals([...selected, candidate]);
    const reasons: string[] = [];
    if (withCandidate.totalCost > constraint.budget) reasons.push('budget capacity');
    for (const [resource, amount] of Object.entries(withCandidate.resourceUse)) {
      if (amount > (constraint.resourceCapacities[resource] ?? 0)) reasons.push(`${resource} capacity`);
    }
    return { rowId: candidate.rowId, reason: reasons.length ? `Not selected because of ${reasons.join(' and ')}.` : 'Not selected by the objective/tie policy.' };
  });
  const body = {
    schemaVersion: '2.0' as const,
    contextId,
    datasetSnapshotRevision,
    selectedRowIds: selected.map((candidate) => candidate.rowId).sort(),
    excluded,
    ...resultTotals,
    constraint: structuredClone(constraint),
    candidates: structuredClone(candidates),
    objectiveRankingResultId,
    method: exact ? 'EXACT' as const : 'BOUNDED_GREEDY' as const,
    globallyOptimal: exact,
  };
  const checksum = await canonicalDigest({ schema: 'erp-portfolio-result/2', ...body });
  return { ...body, id: `portfolio-${checksum.slice(7, 23)}`, createdAt: now, checksum };
}
