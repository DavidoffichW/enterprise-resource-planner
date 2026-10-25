import { useMemo, useRef, useState } from 'react';
import type {
  DecisionDraft,
  DecisionObjective,
  EligibilityRule,
  PersistedApplicationState,
  PlanningDataset,
  PriorityListRevision,
  RankingResult,
  ScopeMode,
  WorkbookState,
} from '../../contracts';
import {
  compareRankings,
  compareNullableRanks,
  createCandidateScope,
  createDecisionContext,
  createPriorityListRevision,
  createRuleSet,
  defaultEligibilityRules,
  evaluateEligibility,
  optimizePortfolio,
  rankByDemonstrationModel,
  rankByPriorityList,
  rankByWeightedCriteria,
  semanticText,
  semanticValue,
  validateHumanRank,
} from '../../core';
import { createPriorityListFromInspection, exportPriorityList, inspectPriorityListWorkbook, type PriorityListInspection } from '../adapters/priority-list-excel';

interface Props {
  view: 'scope' | 'rankings' | 'portfolio';
  dataset: PlanningDataset;
  workbook: WorkbookState;
  workspaceId: string;
  state: PersistedApplicationState;
  draft: DecisionDraft;
  ensureEvidenceDataset: () => Promise<PlanningDataset>;
  onDraft: (draft: DecisionDraft) => void;
  onState: (state: PersistedApplicationState) => void;
}
function rowLabel(dataset: PlanningDataset, rowId: string): string {
  const identifier = semanticText(dataset, rowId, 'planned_job_identifier') || rowId;
  const description = semanticText(dataset, rowId, 'job_description');
  return description ? `${identifier} — ${description}` : identifier;
}

function downloadBytes(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}

function eligibleIds(draft: DecisionDraft): string[] {
  return draft.eligibility?.evaluations.filter((evaluation) => evaluation.state === 'ELIGIBLE').map((evaluation) => evaluation.rowId) ?? [];
}

export function DecisionWorkspace({ view, dataset, workspaceId, state, draft, ensureEvidenceDataset, onDraft, onState }: Props) {
  const [objective, setObjective] = useState<DecisionObjective>(draft.context?.objective ?? 'JOB_REPLACEMENT');
  const [targetIds, setTargetIds] = useState<string[]>(draft.context?.targetRowIds ?? []);
  const [effectiveDate, setEffectiveDate] = useState(draft.context?.effectiveDate ?? new Date().toISOString().slice(0, 10));
  const [scopeMode, setScopeMode] = useState<ScopeMode>(draft.scope?.mode ?? 'ALL_VALID');
  const [manualIds, setManualIds] = useState<string[]>(draft.scope?.manualIncludedRowIds ?? []);
  const [excludedIds, setExcludedIds] = useState<string[]>(draft.scope?.manualExcludedRowIds ?? []);
  const [filterRole, setFilterRole] = useState<'status' | 'job_category' | 'operational_area'>('status');
  const [filterValue, setFilterValue] = useState('');
  const [viewName, setViewName] = useState('Planning view');
  const [selectedViewId, setSelectedViewId] = useState(draft.scope?.savedViewId ?? '');
  const [ruleDrafts, setRuleDrafts] = useState<EligibilityRule[]>(draft.ruleSet?.rules ?? defaultEligibilityRules());
  const [selectedListId, setSelectedListId] = useState(state.priorityLists[0]?.id ?? '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState(50_000);
  const [portfolioRankingId, setPortfolioRankingId] = useState(draft.rankings[0]?.id ?? '');
  const [resourceCapacities, setResourceCapacities] = useState<Record<string, number>>({ Mechanical: 100, Electrical: 100, Instrumentation: 100, Mixed: 100, HVAC: 100, General: 100 });
  const [inspection, setInspection] = useState<PriorityListInspection | null>(null);
  const [identifierHeader, setIdentifierHeader] = useState('');
  const [rankHeader, setRankHeader] = useState('');
  const listInput = useRef<HTMLInputElement>(null);
  const availableRows = dataset.rows;
  const currentEligible = eligibleIds(draft);
  const currentPopulation = draft.scope?.candidateRowIds ?? [];

  const update = (changes: Partial<DecisionDraft>) => onDraft({ ...draft, ...changes, updatedAt: new Date().toISOString() });
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'The operation failed.'); } finally { setBusy(false); }
  };

  const configure = () => run(async () => {
    const evidenceDataset = await ensureEvidenceDataset();
    const context = createDecisionContext(evidenceDataset, objective, targetIds, effectiveDate);
    const filters = filterValue.trim() ? [{ role: filterRole, operator: 'EQUALS' as const, value: filterValue.trim() }] : [];
    const ruleSet = await createRuleSet('Operator-configured rules', ruleDrafts.map((rule) => rule.id === 'planned-by-cutoff' ? { ...rule, value: effectiveDate } : rule));
    const savedView = scopeMode === 'SAVED_VIEW' ? state.savedViews.find((item) => item.id === selectedViewId) ?? null : null;
    if (scopeMode === 'SAVED_VIEW' && !savedView) throw new Error('Select a saved planning view.');
    let scope = await createCandidateScope(evidenceDataset, context, { mode: scopeMode, filters, manualIncludedRowIds: manualIds, manualExcludedRowIds: excludedIds, savedView, rationale: 'Explicit operator materialization.' });
    let eligibility = await evaluateEligibility(evidenceDataset, context, scope, ruleSet);
    if (scopeMode === 'ALL_ELIGIBLE') {
      scope = await createCandidateScope(evidenceDataset, context, {
        mode: scopeMode,
        eligibleRowIds: eligibility.evaluations.filter((item) => item.state === 'ELIGIBLE').map((item) => item.rowId),
        rationale: 'Materialized from an explicit deterministic eligibility pass.',
      });
      eligibility = await evaluateEligibility(evidenceDataset, context, scope, ruleSet);
    }
    update({ context, scope, ruleSet, eligibility, rankings: [], myRank: [], portfolio: null });
    setNotice(`Candidate Scope materialized with ${scope.candidateRowIds.length} rows; deterministic rules found ${eligibility.evaluations.filter((item) => item.state === 'ELIGIBLE').length} eligible.`);
  });

  const saveView = () => {
    if (!filterValue.trim()) { setError('Enter a filter value before saving a planning view.'); return; }
    const savedView = { id:`view-${crypto.randomUUID()}`, name:viewName.trim()||'Planning view', datasetId:dataset.id, filters:[{role:filterRole,operator:'EQUALS' as const,value:filterValue.trim()}], createdAt:new Date().toISOString() };
    onState({ ...state, savedViews:[...state.savedViews,savedView] });
    setSelectedViewId(savedView.id); setScopeMode('SAVED_VIEW'); setNotice(`Saved planning view “${savedView.name}” for reuse.`); setError('');
  };

  const runRanking = (kind: 'reference' | 'model' | 'priority') => run(async () => {
    if (!draft.context || !draft.scope) throw new Error('Create Candidate Scope first.');
    let result: RankingResult;
    if (kind === 'reference') result = await rankByWeightedCriteria(dataset, draft.context.id, draft.scope, draft.eligibility);
    else if (kind === 'model') result = await rankByDemonstrationModel(dataset, draft.context.id, draft.scope, draft.eligibility);
    else {
      const list = state.priorityLists.find((candidate) => candidate.id === selectedListId);
      if (!list) throw new Error('Select a persistent Priority List.');
      result = await rankByPriorityList(dataset, draft.context.id, draft.scope, draft.eligibility, list);
    }
    const rankings = [...draft.rankings.filter((existing) => existing.source.id !== result.source.id), result];
    const myRank = draft.myRank.length ? draft.myRank : result.ranks.filter((rank) => rank.rank !== null).sort((a, b) => a.rank! - b.rank!).map((rank, index) => ({ rowId: rank.rowId, myRank: index + 1 }));
    update({ rankings, activeRankingId: result.id, myRank });
    setPortfolioRankingId((current) => current || result.id);
    setNotice(`${result.source.label} ranked ${result.ranks.filter((rank) => rank.rank !== null).length} eligible candidates.`);
  });

  const createDemoList = () => run(async () => {
    if (!dataset.grainColumnId) throw new Error('A confirmed dataset grain is required.');
    const entries = availableRows.map((row) => ({
      itemId: String(row.cells[dataset.grainColumnId!].normalized ?? ''),
      priorityRank: 0,
      additionalFields: { Priority: semanticText(dataset, row.id, 'priority') },
    })).sort((left, right) => {
      const leftPriority = Number(left.additionalFields.Priority.replace(/\D/g, '')) || 99;
      const rightPriority = Number(right.additionalFields.Priority.replace(/\D/g, '')) || 99;
      return leftPriority - rightPriority || left.itemId.localeCompare(right.itemId);
    }).map((entry, index) => ({ ...entry, priorityRank: index + 1 }));
    const list = await createPriorityListRevision('Synthetic demonstration priority list', 'Planned Job ID', 'Priority Rank', entries, 'independently-generated-in-application');
    onState({ ...state, priorityLists: [...state.priorityLists.filter((item) => item.id !== list.id), list] });
    setSelectedListId(list.id);
    setNotice('A reusable synthetic Priority List revision was created explicitly from the displayed synthetic plan.');
  });

  const importList = () => run(async () => {
    if (!inspection) throw new Error('Select and inspect a Priority List workbook first.');
    const list = await createPriorityListFromInspection(inspection, inspection.sourceName.replace(/\.xlsx$/i, ''), identifierHeader, rankHeader);
    onState({ ...state, priorityLists: [...state.priorityLists.filter((item) => item.id !== list.id), list] });
    setSelectedListId(list.id);
    setInspection(null);
    setNotice(`Priority List “${list.name}” revision imported with ${list.entries.length} entries.`);
  });

  const exportList = () => run(async () => {
    const list = state.priorityLists.find((candidate) => candidate.id === selectedListId);
    if (!list) throw new Error('Select a Priority List to export.');
    downloadBytes(await exportPriorityList(list), `erp-priority-list-${list.id}.xlsx`);
    setNotice(`Priority List “${list.name}” exported with explicit identifier and rank columns.`);
  });

  const comparison = useMemo(() => {
    try { return draft.rankings.length >= 2 ? compareRankings(draft.rankings) : null; } catch { return null; }
  }, [draft.rankings]);

  const moveMyRank = (rowId: string, direction: -1 | 1) => {
    const ordered = [...draft.myRank].sort((a, b) => a.myRank - b.myRank);
    const index = ordered.findIndex((item) => item.rowId === rowId);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= ordered.length) return;
    [ordered[index], ordered[destination]] = [ordered[destination], ordered[index]];
    update({ myRank: ordered.map((item, itemIndex) => ({ ...item, myRank: itemIndex + 1 })) });
  };

  const optimize = () => run(async () => {
    if (!draft.context || !draft.scope || !dataset.snapshotRevision) throw new Error('Create a decision context before portfolio optimization.');
    const ranking = draft.rankings.find((item) => item.id === portfolioRankingId);
    if (!ranking) throw new Error('Select a ranking result as the portfolio objective.');
    const candidates = currentPopulation.map((rowId) => {
      const rank = ranking?.ranks.find((item) => item.rowId === rowId)?.rank;
      const cost = semanticValue(dataset, rowId, 'estimated_cost');
      const resource = semanticText(dataset, rowId, 'resource_requirement');
      const duration = semanticValue(dataset, rowId, 'estimated_duration');
      if (typeof cost !== 'number' || typeof duration !== 'number' || !resource) throw new Error(`Candidate ${rowLabel(dataset, rowId)} lacks portfolio cost/resource inputs.`);
      if (!rank) throw new Error(`Candidate ${rowLabel(dataset, rowId)} has no rank in the selected objective source.`);
      return { rowId, value: currentPopulation.length - rank + 1, cost, resourceRequirements: { [resource]: duration } };
    });
    const portfolio = await optimizePortfolio(draft.context.id, dataset.snapshotRevision, candidates, { budget, resourceCapacities }, new Date().toISOString(), ranking.id);
    update({ portfolio });
    setNotice(`${portfolio.method} portfolio selected ${portfolio.selectedRowIds.length} jobs within budget and resource capacities.`);
  });

  if (view === 'scope') return (
    <section className="module-stack" aria-labelledby="scope-title">
      <div className="module-hero"><p className="eyebrow">Scope and Rules</p><h1 id="scope-title">Define the exact decision population.</h1><p>Planned items, Candidate Scope, validation, eligibility, and feasibility remain separate evidence states.</p></div>
      <section className="panel"><h2>Decision context</h2>
        <div className="form-grid">
          <label>Objective<select value={objective} onChange={(event) => setObjective(event.target.value as DecisionObjective)}><option value="JOB_REPLACEMENT">Job replacement</option><option value="GROUP_REPLACEMENT">Group replacement</option><option value="PRIORITIZATION">Prioritization</option><option value="PORTFOLIO">Portfolio planning</option></select></label>
          <label>Effective date<input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></label>
          <label className="wide">Planned item or group<select multiple size={6} value={targetIds} onChange={(event) => setTargetIds([...event.currentTarget.selectedOptions].map((option) => option.value))}>{availableRows.map((row) => <option key={row.id} value={row.id}>{rowLabel(dataset, row.id)}</option>)}</select></label>
          <label>Candidate Scope mode<select value={scopeMode} onChange={(event) => setScopeMode(event.target.value as ScopeMode)}><option value="ALL_VALID">All valid candidates</option><option value="ALL_ELIGIBLE">All eligible candidates</option><option value="FILTERED">Filtered set</option><option value="MANUAL">Manual set</option><option value="FILTERED_MANUAL">Filtered plus manual adjustments</option><option value="SAVED_VIEW">Saved planning view</option></select></label>
          <label>Filter role<select value={filterRole} onChange={(event) => setFilterRole(event.target.value as typeof filterRole)}><option value="status">Status</option><option value="job_category">Job category</option><option value="operational_area">Operational area</option></select></label>
          <label>Exact filter value<input value={filterValue} onChange={(event) => setFilterValue(event.target.value)} placeholder="Optional" /></label>
          <label>Planning view name<input value={viewName} onChange={(event)=>setViewName(event.target.value)}/></label>
          <button className="button secondary" type="button" onClick={saveView}>Save current filter as view</button>
          <label>Saved planning view<select value={selectedViewId} onChange={(event)=>setSelectedViewId(event.target.value)}><option value="">Select a saved view</option>{state.savedViews.filter((item)=>item.datasetId===dataset.id).map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        {(scopeMode === 'MANUAL' || scopeMode === 'FILTERED_MANUAL') && <fieldset className="candidate-checks"><legend>Explicit manual candidates</legend>{availableRows.filter((row) => !targetIds.includes(row.id)).map((row) => <label key={row.id}><input type="checkbox" checked={manualIds.includes(row.id)} onChange={(event) => setManualIds(event.target.checked ? [...manualIds, row.id] : manualIds.filter((id) => id !== row.id))} />{rowLabel(dataset, row.id)}</label>)}</fieldset>}
        <fieldset className="candidate-checks"><legend>Explicit exclusions from this scope</legend>{availableRows.filter((row) => !targetIds.includes(row.id)).map((row) => <label key={row.id}><input type="checkbox" checked={excludedIds.includes(row.id)} onChange={(event) => setExcludedIds(event.target.checked ? [...excludedIds, row.id] : excludedIds.filter((id) => id !== row.id))} />{rowLabel(dataset, row.id)}</label>)}</fieldset>
      </section>
      <section className="panel"><h2>Deterministic rules</h2><p>Rules execute in displayed order before any ranking source.</p>
        <div className="rule-list">{ruleDrafts.map((rule, index) => <div className="rule-card" key={rule.id}><label><input type="checkbox" checked={rule.enabled} onChange={(event) => setRuleDrafts(ruleDrafts.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item))} />{rule.label}</label><span>{rule.role.replaceAll('_', ' ')} · {rule.operator.replaceAll('_', ' ')}</span>{rule.value !== null && <input aria-label={`Rule value for ${rule.label}`} value={String(rule.value)} onChange={(event) => setRuleDrafts(ruleDrafts.map((item, itemIndex) => itemIndex === index ? { ...item, value: rule.operator === 'LTE' || rule.operator === 'GTE' ? Number(event.target.value) : event.target.value } : item))} />}</div>)}</div>
        <button className="button primary" type="button" disabled={busy} onClick={() => void configure()}>Materialize scope and evaluate rules</button>
      </section>
      {draft.eligibility && <section className="panel"><h2>Eligibility evidence</h2><div className="state-summary">{['ELIGIBLE','INELIGIBLE','INFEASIBLE','REVIEW_REQUIRED','INVALID','OUTSIDE_SCOPE','EXCLUDED'].map((value) => <span key={value}><b>{draft.eligibility!.evaluations.filter((item) => item.state === value).length}</b>{value.replaceAll('_',' ')}</span>)}</div><div className="evidence-table-wrap"><table><thead><tr><th>Item</th><th>State</th><th>Reason</th></tr></thead><tbody>{draft.eligibility.evaluations.map((evaluation) => <tr key={evaluation.rowId}><td>{rowLabel(dataset,evaluation.rowId)}</td><td>{evaluation.state}</td><td>{evaluation.reasons.join(' ')}</td></tr>)}</tbody></table></div></section>}
      {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status">{notice}</div>}
    </section>
  );

  if (view === 'rankings') return (
    <section className="module-stack" aria-labelledby="rank-title"><div className="module-hero"><p className="eyebrow">Rankings and Model Comparison</p><h1 id="rank-title">Compare transparent sources over one eligible population.</h1><p>Priority Rank, Model Rank, and My Rank remain independent.</p></div>
      <section className="panel"><h2>Persistent Priority Lists</h2><div className="panel-actions"><button className="button secondary" onClick={() => void createDemoList()} disabled={busy}>Create synthetic list</button><button className="button secondary" onClick={() => listInput.current?.click()} disabled={busy}>Import Priority List .xlsx</button><button className="button secondary" onClick={() => void exportList()} disabled={busy || !selectedListId}>Export selected list</button><input ref={listInput} className="sr-only" type="file" accept=".xlsx" onChange={(event) => { const file=event.target.files?.[0]; if(!file)return; void run(async()=>{const inspected=await inspectPriorityListWorkbook(new Uint8Array(await file.arrayBuffer()),file.name);setInspection(inspected);setIdentifierHeader(inspected.headers[0]??'');setRankHeader(inspected.headers[1]??'');}); }} /></div>
        {inspection && <div className="form-grid"><label>Item identifier column<select value={identifierHeader} onChange={(event)=>setIdentifierHeader(event.target.value)}>{inspection.headers.map((header)=><option key={header}>{header}</option>)}</select></label><label>Priority Rank column<select value={rankHeader} onChange={(event)=>setRankHeader(event.target.value)}>{inspection.headers.map((header)=><option key={header}>{header}</option>)}</select></label><button className="button primary" onClick={()=>void importList()}>Confirm Priority List mapping</button></div>}
        <label>Selected Priority List<select value={selectedListId} onChange={(event)=>setSelectedListId(event.target.value)}><option value="">Select a list</option>{state.priorityLists.map((list)=><option key={list.id} value={list.id}>{list.name} · {list.entries.length} entries</option>)}</select></label>
      </section>
      <section className="panel"><h2>Ranking sources</h2><div className="panel-actions"><button className="button primary" onClick={()=>void runRanking('priority')} disabled={busy || !selectedListId}>Apply Priority List</button><button className="button secondary" onClick={()=>void runRanking('reference')} disabled={busy}>Run weighted reference</button><button className="button secondary" onClick={()=>void runRanking('model')} disabled={busy}>Run synthetic demo model</button></div><p className="inline-help">The demonstration model uses only declared priority, cost, and duration features. Its score is not probability, confidence, or field accuracy.</p></section>
      {draft.rankings.map((result)=><section className="panel" key={result.id}><h2>{result.source.label}</h2><p>{result.source.scoreMeaning}</p><div className="evidence-table-wrap"><table><thead><tr><th>Rank</th><th>Item</th><th>Score</th><th>Exact explanation</th></tr></thead><tbody>{result.ranks.slice().sort((a,b)=>compareNullableRanks(a,b,'asc')).map((rank)=><tr key={rank.rowId}><td>{rank.rank??'—'}</td><td>{rowLabel(dataset,rank.rowId)}</td><td>{rank.score?.toFixed(4)??'Unranked'}</td><td>{rank.explanation.join(' ')}</td></tr>)}</tbody></table></div></section>)}
      {comparison && <section className="panel"><h2>Common-population comparison</h2><p>{comparison.sourceIds.length} sources · top-{comparison.topK} overlap {(comparison.topKOverlap*100).toFixed(0)}%.</p><p className="inline-help">{comparison.limitations.join(' ')}</p></section>}
      {draft.myRank.length>0 && <section className="panel"><h2>My Rank working order</h2><p>Moving rows is a preview. Saving it into a Case is an explicit event.</p><ol className="my-rank-list">{draft.myRank.slice().sort((a,b)=>a.myRank-b.myRank).map((item)=><li key={item.rowId}><span>{item.myRank}. {rowLabel(dataset,item.rowId)}</span><button aria-label={`Move ${rowLabel(dataset,item.rowId)} up`} onClick={()=>moveMyRank(item.rowId,-1)}>↑</button><button aria-label={`Move ${rowLabel(dataset,item.rowId)} down`} onClick={()=>moveMyRank(item.rowId,1)}>↓</button></li>)}</ol><button className="button secondary" onClick={()=>{try{update({myRank:validateHumanRank(draft.myRank,currentEligible)});setNotice('My Rank validated. Record a Case event to commit it.');}catch(caught){setError(caught instanceof Error?caught.message:'My Rank validation failed.');}}}>Validate My Rank</button></section>}
      {error&&<div className="notice error" role="alert">{error}</div>}{notice&&<div className="notice success" role="status">{notice}</div>}
    </section>
  );

  const resources = [...new Set(currentPopulation.map((rowId)=>semanticText(dataset,rowId,'resource_requirement')).filter(Boolean))];
  return <section className="module-stack" aria-labelledby="portfolio-title"><div className="module-hero"><p className="eyebrow">Portfolio</p><h1 id="portfolio-title">Select a feasible budget and resource portfolio.</h1><p>Hard feasibility is separate from ranking preference.</p></div><section className="panel"><div className="form-grid"><label>Objective ranking<select value={portfolioRankingId} onChange={(event)=>setPortfolioRankingId(event.target.value)}><option value="">Select a completed ranking</option>{draft.rankings.map((ranking)=><option key={ranking.id} value={ranking.id}>{ranking.source.label}</option>)}</select></label><label>Budget<input type="number" min="0" value={budget} onChange={(event)=>setBudget(Number(event.target.value))}/></label>{resources.map((resource)=><label key={resource}>{resource} capacity<input type="number" min="0" value={resourceCapacities[resource]??0} onChange={(event)=>setResourceCapacities({...resourceCapacities,[resource]:Number(event.target.value)})}/></label>)}</div><button className="button primary" onClick={()=>void optimize()} disabled={busy || !portfolioRankingId}>Optimize feasible portfolio</button></section>{draft.portfolio&&<section className="panel"><h2>Portfolio result</h2><div className="state-summary"><span><b>{draft.portfolio.selectedRowIds.length}</b>selected</span><span><b>{draft.portfolio.totalCost.toLocaleString()}</b>total cost</span><span><b>{draft.portfolio.totalValue.toFixed(2)}</b>objective value</span><span><b>{draft.portfolio.method}</b>{draft.portfolio.globallyOptimal?'proven exact':'approximate'}</span></div><h3>Selected</h3><ul>{draft.portfolio.selectedRowIds.map((id)=><li key={id}>{rowLabel(dataset,id)}</li>)}</ul><h3>Not selected</h3><ul>{draft.portfolio.excluded.map((item)=><li key={item.rowId}>{rowLabel(dataset,item.rowId)} — {item.reason}</li>)}</ul></section>}{error&&<div className="notice error" role="alert">{error}</div>}{notice&&<div className="notice success" role="status">{notice}</div>}</section>;
}
