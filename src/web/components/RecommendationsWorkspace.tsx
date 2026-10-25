import { useEffect, useMemo, useRef, useState } from 'react';
import type { DecisionDraft, PersistedApplicationState, PlanningDataset, RankingResult, WorkbookState } from '../../contracts';
import {
  compareNullableRanks,
  createCandidateScope,
  createDecisionContext,
  createPriorityListRevision,
  createRuleSet,
  defaultEligibilityRules,
  evaluateEligibility,
  FACILITIES_EXAMPLE_PRIORITY_ORDER,
  rankByDemonstrationModel,
  rankByPriorityList,
  rankByWeightedCriteria,
  recordReplacementDecision,
  semanticText,
  semanticValue,
} from '../../core';
import { createPriorityListFromInspection, exportPriorityList, inspectPriorityListWorkbook, type PriorityListInspection } from '../adapters/priority-list-excel';

interface Props {
  dataset: PlanningDataset;
  workbook: WorkbookState;
  workspaceId: string;
  state: PersistedApplicationState;
  draft: DecisionDraft;
  ensureEvidenceDataset: () => Promise<PlanningDataset>;
  onDraft: (draft: DecisionDraft) => void;
  onState: (state: PersistedApplicationState) => void;
}

function rowIdentity(dataset: PlanningDataset, rowId: string) {
  return semanticText(dataset, rowId, 'planned_job_identifier') || semanticText(dataset, rowId, 'asset_identifier') || rowId;
}
function rowDescription(dataset: PlanningDataset, rowId: string) { return semanticText(dataset, rowId, 'job_description') || 'No description'; }
function rowLabel(dataset: PlanningDataset, rowId: string) { return `${rowIdentity(dataset, rowId)} — ${rowDescription(dataset, rowId)}`; }
function rankingDisplayLabel(result: RankingResult | null) {
  if (!result) return 'Manual selection';
  if (result.source.type === 'DEMONSTRATION_MODEL') return 'Example model';
  if (result.source.type === 'REFERENCE') return 'Weighted reference';
  return result.source.label;
}
function downloadBytes(bytes: Uint8Array, filename: string) { const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function rankingMatches(result: RankingResult | null, draft: DecisionDraft, dataset: PlanningDataset, targetId: string) {
  return Boolean(result && draft.context && draft.scope && draft.context.targetRowIds.length === 1 && draft.context.targetRowIds[0] === targetId && draft.context.datasetSnapshotRevision === dataset.snapshotRevision && result.contextId === draft.context.id && result.scopeRevision === draft.scope.revision && result.datasetSnapshotRevision === draft.context.datasetSnapshotRevision);
}

export function RecommendationsWorkspace({ dataset, workbook, workspaceId, state, draft, ensureEvidenceDataset, onDraft, onState }: Props) {
  const [targetId, setTargetId] = useState(draft.context?.targetRowIds[0] ?? dataset.rows[0]?.id ?? '');
  const [effectiveDate] = useState(draft.context?.effectiveDate ?? new Date().toISOString().slice(0, 10));
  const [jobSearch, setJobSearch] = useState('');
  const [candidateSearch, setCandidateSearch] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [rankingChoice, setRankingChoice] = useState(() => state.priorityLists[0] ? `priority:${state.priorityLists[0].id}` : 'manual');
  const [inspection, setInspection] = useState<PriorityListInspection | null>(null);
  const [identifierHeader, setIdentifierHeader] = useState('');
  const [rankHeader, setRankHeader] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const listInput = useRef<HTMLInputElement>(null);

  const update = (changes: Partial<DecisionDraft>) => onDraft({ ...draft, ...changes, updatedAt: new Date().toISOString() });
  const activeResultCandidate = draft.rankings.find((item) => item.id === draft.activeRankingId) ?? null;
  const activeResult = rankingMatches(activeResultCandidate, draft, dataset, targetId) ? activeResultCandidate : null;
  const target = dataset.rows.find((row) => row.id === targetId) ?? null;

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'The operation could not be completed.'); }
    finally { setBusy(false); }
  };

  const prepareDecision = async () => {
    const evidenceDataset = await ensureEvidenceDataset();
    if (draft.context && draft.scope && draft.context.targetRowIds[0] === targetId && draft.context.datasetSnapshotRevision === evidenceDataset.snapshotRevision && draft.context.effectiveDate === effectiveDate) {
      return { evidenceDataset, context: draft.context, scope: draft.scope, ruleSet: draft.ruleSet, eligibility: draft.eligibility };
    }
    const context = createDecisionContext(evidenceDataset, 'JOB_REPLACEMENT', [targetId], effectiveDate);
    const ruleSet = await createRuleSet('Standard replacement checks', defaultEligibilityRules().map((rule) => rule.id === 'planned-by-cutoff' ? { ...rule, value: effectiveDate } : rule));
    const scope = await createCandidateScope(evidenceDataset, context, { mode: 'ALL_VALID', manualExcludedRowIds: [targetId], rationale: 'Available valid planning rows excluding the selected job.' });
    const eligibility = await evaluateEligibility(evidenceDataset, context, scope, ruleSet);
    return { evidenceDataset, context, scope, ruleSet, eligibility };
  };

  const changeTarget = (next: string) => {
    setTargetId(next); setSelectedCandidateId(''); setError('');
    if (draft.context && draft.context.targetRowIds[0] !== next) {
      update({ context: null, scope: null, ruleSet: null, eligibility: null, rankings: [], activeRankingId: null, myRank: [], portfolio: null });
      setNotice('Job changed. Choose how to rank the available replacements.');
    }
  };

  const applyRanking = () => run(async () => {
    if (!targetId) throw new Error('Choose a job to replace.');
    const prepared = await prepareDecision();
    if (rankingChoice === 'manual') {
      update({ context: prepared.context, scope: prepared.scope, ruleSet: prepared.ruleSet, eligibility: prepared.eligibility, rankings: [], activeRankingId: null, myRank: [], portfolio: null });
      setNotice('Manual selection is ready. Choose any valid replacement below.');
      return;
    }
    let result: RankingResult;
    if (rankingChoice === 'reference') result = await rankByWeightedCriteria(prepared.evidenceDataset, prepared.context.id, prepared.scope, prepared.eligibility);
    else if (rankingChoice === 'model') result = await rankByDemonstrationModel(prepared.evidenceDataset, prepared.context.id, prepared.scope, prepared.eligibility);
    else {
      const listId = rankingChoice.slice('priority:'.length);
      const list = state.priorityLists.find((item) => item.id === listId);
      if (!list) throw new Error('Choose a saved priority list.');
      result = await rankByPriorityList(prepared.evidenceDataset, prepared.context.id, prepared.scope, prepared.eligibility, list);
    }
    update({ context: prepared.context, scope: prepared.scope, ruleSet: prepared.ruleSet, eligibility: prepared.eligibility, rankings: [result], activeRankingId: result.id, myRank: [], portfolio: null });
    const top = result.ranks.slice().sort((a, b) => compareNullableRanks(a, b, 'asc')).find((rank) => rank.rank !== null);
    setSelectedCandidateId(top?.rowId ?? '');
    setNotice(`${rankingDisplayLabel(result)} applied to the available replacements.`);
  });

  const createExamplePriorities = () => run(async () => {
    if (dataset.sourceIdentity !== 'synthetic:facilities-scheduling:recipe-1:seed-271828') throw new Error('Example priorities are available only for the Facilities example. Import a priority list for other plans.');
    const entries = FACILITIES_EXAMPLE_PRIORITY_ORDER.map((itemId, index) => ({ itemId, priorityRank: index + 1, additionalFields: {} }));
    const list = await createPriorityListRevision('Example priorities', 'Planned Job ID', 'Priority Rank', entries, 'built-in-facilities-example');
    onState({ ...state, priorityLists: [...state.priorityLists.filter((item) => item.id !== list.id), list] });
    setRankingChoice(`priority:${list.id}`);
    setNotice('Example priorities created. Choose Apply ranking to use them.');
  });

  const importList = () => run(async () => {
    if (!inspection) throw new Error('Choose a priority-list workbook first.');
    const list = await createPriorityListFromInspection(inspection, inspection.sourceName.replace(/\.xlsx$/i, ''), identifierHeader, rankHeader);
    onState({ ...state, priorityLists: [...state.priorityLists.filter((item) => item.id !== list.id), list] });
    setRankingChoice(`priority:${list.id}`); setInspection(null);
    setNotice(`Priority list “${list.name}” imported. Choose Apply ranking to use it.`);
  });
  const exportList = () => run(async () => {
    const listId = rankingChoice.startsWith('priority:') ? rankingChoice.slice('priority:'.length) : '';
    const list = state.priorityLists.find((item) => item.id === listId);
    if (!list) throw new Error('Choose a saved priority list to export.');
    downloadBytes(await exportPriorityList(list), `erp-priority-list-${list.id}.xlsx`);
    setNotice(`Priority list “${list.name}” exported.`);
  });

  const rows = useMemo(() => {
    const byId = new Map(dataset.rows.map((row) => [row.id, row]));
    const ranked = activeResult?.ranks.slice().sort((a, b) => compareNullableRanks(a, b, 'asc')) ?? [];
    const rankedIds = new Set(ranked.map((item) => item.rowId));
    const items = activeResult
      ? [...ranked.map((rank) => ({ row: byId.get(rank.rowId)!, rank })), ...dataset.rows.filter((row) => row.id !== targetId && !rankedIds.has(row.id)).map((row) => ({ row, rank: null }))]
      : dataset.rows.filter((row) => row.id !== targetId).map((row) => ({ row, rank: null }));
    const query = candidateSearch.trim().toLocaleLowerCase('en-US');
    return query ? items.filter(({ row }) => rowLabel(dataset, row.id).toLocaleLowerCase('en-US').includes(query)) : items;
  }, [activeResult, candidateSearch, dataset, targetId]);
  const topRanked = activeResult?.ranks.slice().sort((a, b) => compareNullableRanks(a, b, 'asc')).find((rank) => rank.rank !== null) ?? null;
  useEffect(() => {
    if (topRanked) setSelectedCandidateId(topRanked.rowId);
    else if (!selectedCandidateId || selectedCandidateId === targetId || !dataset.rows.some((row) => row.id === selectedCandidateId && row.readiness === 'READY')) setSelectedCandidateId(dataset.rows.find((row) => row.id !== targetId && row.readiness === 'READY')?.id ?? '');
  }, [activeResult?.id, targetId]);

  const selected = dataset.rows.find((row) => row.id === selectedCandidateId) ?? null;
  const selectedRank = activeResult?.ranks.find((rank) => rank.rowId === selectedCandidateId) ?? null;
  const filteredTargets = dataset.rows.filter((row) => rowLabel(dataset, row.id).toLocaleLowerCase('en-US').includes(jobSearch.trim().toLocaleLowerCase('en-US'))).slice(0, 100);

  const useReplacement = () => run(async () => {
    if (!selected) throw new Error('Choose a replacement.');
    if (selected.readiness !== 'READY') throw new Error('This row needs correction or review before it can be used in a decision.');
    const prepared = await prepareDecision();
    const applicableRanking = activeResult && rankingMatches(activeResult, draft, prepared.evidenceDataset, targetId) ? activeResult : null;
    if (draft.activeRankingId && !applicableRanking) throw new Error('The displayed ranking no longer matches this job. Apply the ranking again.');
    const evidenceWorkbook = { ...workbook, sheets: workbook.sheets.map((sheet, index) => index === workbook.activeSheetIndex ? prepared.evidenceDataset : sheet) };
    const snapshot = { workbook: evidenceWorkbook, dataset: prepared.evidenceDataset, context: prepared.context, scope: prepared.scope, ruleSet: prepared.ruleSet, eligibility: prepared.eligibility, rankings: applicableRanking ? [applicableRanking] : [], myRank: [], portfolio: null, relationships: [], historicalEvents: [] };
    const recorded = await recordReplacementDecision(state.cases, { name: `Replacement · ${rowIdentity(dataset, targetId)}`, snapshot, selectedRowId: selected.id, rankingResultId: applicableRanking?.id ?? null, actorLabel: 'Local operator', reason: applicableRanking ? `Selected after reviewing ${applicableRanking.source.label}.` : 'Selected manually.' });
    if (recorded.created) onState({ ...state, cases: [...state.cases, recorded.planningCase] });
    setNotice(recorded.created ? 'Replacement saved.' : 'This replacement is already saved for the same job, date, scope, and ranking.');
  });

  const sourceLabel = activeResult ? rankingDisplayLabel(activeResult) : (rankingChoice === 'manual' ? 'Manual selection' : 'Not applied');
  const selectionTitle = selected && topRanked?.rowId === selected.id && selectedRank?.rank !== null
    ? `Top available candidate — Priority ${selectedRank!.rank}`
    : selectedRank?.rank !== null && selectedRank ? `Selected candidate — Priority ${selectedRank.rank}` : 'Selected candidate';

  return <section className="recommendations-workspace" aria-labelledby="recommendations-title">
    <div className="page-header recommendation-heading"><div><p className="eyebrow">Recommendations</p><h1 id="recommendations-title">Replace a job</h1><p>Choose the planned job, review the available replacements, and save your selection.</p></div></div>
    <section className="recommendation-toolbar panel" aria-label="Recommendation controls">
      <label className="field-stack job-search">Job to replace<input type="search" value={jobSearch} onChange={(event) => setJobSearch(event.target.value)} placeholder="Find by job ID or description" /></label>
      <label className="field-stack job-select"><span className="sr-only">Selected job to replace</span><select aria-label="Selected job to replace" value={targetId} onChange={(event) => changeTarget(event.target.value)}>{filteredTargets.map((row) => <option key={row.id} value={row.id}>{rowLabel(dataset, row.id)}</option>)}</select></label>
      <label className="field-stack rank-select">Rank by<select value={rankingChoice} onChange={(event) => setRankingChoice(event.target.value)}><option value="manual">Manual selection</option>{state.priorityLists.map((list) => <option key={list.id} value={`priority:${list.id}`}>{list.name}</option>)}<option value="reference">Weighted reference</option><option value="model">Example model</option></select></label>
      <button className="button primary apply-ranking" type="button" disabled={busy || !targetId} onClick={() => void applyRanking()}>Apply ranking</button>
      <span className="ranking-status"><span>Current ranking</span><strong>{sourceLabel}</strong></span>
    </section>

    <div className="recommendation-layout">
      <section className="panel candidate-panel" aria-labelledby="candidate-title"><div className="panel-heading"><div><h2 id="candidate-title">Available replacements</h2><p>{rows.length} matching jobs · unranked jobs remain at the bottom</p></div><label className="compact-search"><span className="sr-only">Search candidates</span><input type="search" value={candidateSearch} onChange={(event) => setCandidateSearch(event.target.value)} placeholder="Search candidates" /></label></div>
        <div className="candidate-table-wrap"><table className="candidate-table"><thead><tr><th>Priority</th><th>Job</th><th>Description</th><th>Area</th><th>Cost</th><th>Status</th></tr></thead><tbody>{rows.map(({ row, rank }) => <tr key={row.id} className={selectedCandidateId === row.id ? 'selected' : ''} aria-selected={selectedCandidateId === row.id} onClick={() => row.readiness === 'READY' && setSelectedCandidateId(row.id)}><td>{rank?.rank ?? '—'}</td><td><button type="button" disabled={row.readiness !== 'READY'} onClick={() => setSelectedCandidateId(row.id)}>{rowIdentity(dataset, row.id)}</button></td><td>{rowDescription(dataset, row.id)}</td><td>{semanticText(dataset, row.id, 'operational_area') || '—'}</td><td>{typeof semanticValue(dataset, row.id, 'estimated_cost') === 'number' ? Number(semanticValue(dataset, row.id, 'estimated_cost')).toLocaleString() : '—'}</td><td><span className={`row-status ${row.readiness.toLocaleLowerCase('en-US')}`}>{row.readiness === 'READY' ? semanticText(dataset, row.id, 'status') || 'Ready' : 'Needs review'}</span></td></tr>)}</tbody></table></div>
      </section>
      <aside className="panel replacement-panel" aria-labelledby="replacement-title"><p className="eyebrow">Selection</p><h2 id="replacement-title">{selectionTitle}</h2>{selected && target ? <><div className="comparison-block"><span>Replacing</span><strong>{rowIdentity(dataset, target.id)}</strong><small>{rowDescription(dataset, target.id)}</small></div><div className="comparison-arrow" aria-hidden="true">↓</div><div className="comparison-block selected"><span>With</span><strong>{rowIdentity(dataset, selected.id)}</strong><small>{rowDescription(dataset, selected.id)}</small></div><dl className="selection-facts"><div><dt>Area</dt><dd>{semanticText(dataset, selected.id, 'operational_area') || '—'}</dd></div><div><dt>Resource</dt><dd>{semanticText(dataset, selected.id, 'resource_requirement') || '—'}</dd></div><div><dt>Planned date</dt><dd>{String(semanticValue(dataset, selected.id, 'planned_date') ?? '—')}</dd></div></dl><button className="button primary accept-replacement" type="button" disabled={busy || selected.readiness !== 'READY'} onClick={() => void useReplacement()}>Use this replacement</button></> : <p className="empty-copy">Select an available job from the list.</p>}
      </aside>
    </div>

    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status">{notice}</div>}

    <div className="secondary-drawers">
      <details className="workbench-details"><summary>Priority lists <span>{state.priorityLists.length}</span></summary><div className="drawer-content"><div className="panel-actions"><button className="button secondary" type="button" onClick={() => listInput.current?.click()} disabled={busy}>Import priority list</button>{dataset.sourceIdentity === 'synthetic:facilities-scheduling:recipe-1:seed-271828' && <button className="button secondary" type="button" onClick={() => void createExamplePriorities()} disabled={busy}>Create example priorities</button>}<button className="button secondary" type="button" onClick={() => void exportList()} disabled={busy || !rankingChoice.startsWith('priority:')}>Export selected list</button><input ref={listInput} className="sr-only" type="file" accept=".xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void run(async () => { const inspected = await inspectPriorityListWorkbook(new Uint8Array(await file.arrayBuffer()), file.name); setInspection(inspected); setIdentifierHeader(inspected.headers[0] ?? ''); setRankHeader(inspected.headers[1] ?? ''); }); event.currentTarget.value = ''; }} /></div>{inspection && <div className="form-grid priority-mapping"><label>Job identifier column<select value={identifierHeader} onChange={(event) => setIdentifierHeader(event.target.value)}>{inspection.headers.map((header) => <option key={header}>{header}</option>)}</select></label><label>Priority column<select value={rankHeader} onChange={(event) => setRankHeader(event.target.value)}>{inspection.headers.map((header) => <option key={header}>{header}</option>)}</select></label><button className="button primary" type="button" onClick={() => void importList()}>Import list</button></div>}</div></details>
      <details className="workbench-details"><summary>Checks and details <span>{draft.eligibility ? `${draft.eligibility.evaluations.filter((item) => item.state === 'ELIGIBLE').length} eligible` : 'Not run'}</span></summary><div className="drawer-content checks-grid"><div><h3>Availability checks</h3><p>{draft.eligibility ? `${draft.eligibility.evaluations.filter((item) => item.state === 'ELIGIBLE').length} eligible, ${draft.eligibility.evaluations.filter((item) => item.state !== 'ELIGIBLE').length} excluded or needing review.` : 'Apply a ranking or choose manual selection to run checks.'}</p>{draft.eligibility && <ul>{draft.eligibility.evaluations.filter((item) => item.state !== 'ELIGIBLE').slice(0, 12).map((item) => <li key={item.rowId}><strong>{rowIdentity(dataset, item.rowId)}</strong> — {item.reasons.join(' ')}</li>)}</ul>}</div><details><summary>Technical source details</summary><p>Planning-data revision: {dataset.snapshotRevision ? 'Recorded' : 'Pending export'}</p><p>Mapping revision: {dataset.mappingRevision ? 'Recorded' : 'Pending export'}</p><p>Ranking source: {activeResult?.source.scoreMeaning ?? 'Manual selection has no score.'}</p></details></div></details>
    </div>
  </section>;
}
