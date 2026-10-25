import { useMemo, useRef, useState } from 'react';
import type { DecisionDraft, PersistedApplicationState, PlanningDataset, PriorityListRevision, RankingResult, WorkbookState } from '../../contracts';
import {
  compareNullableRanks,
  createCandidateScope,
  createDecisionContext,
  createPriorityListRevision,
  createRuleSet,
  defaultEligibilityRules,
  evaluateEligibility,
  rankByDemonstrationModel,
  rankByPriorityList,
  rankByWeightedCriteria,
  recordReplacementDecision,
  semanticText,
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

function rowLabel(dataset: PlanningDataset, rowId: string): string {
  const identifier = semanticText(dataset, rowId, 'planned_job_identifier') || semanticText(dataset, rowId, 'asset_identifier') || rowId;
  const description = semanticText(dataset, rowId, 'job_description');
  return description ? `${identifier} — ${description}` : identifier;
}

function downloadBytes(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}

export function RecommendationsWorkspace({ dataset, workbook, workspaceId, state, draft, ensureEvidenceDataset, onDraft, onState }: Props) {
  const [targetId, setTargetId] = useState(draft.context?.targetRowIds[0] ?? dataset.rows[0]?.id ?? '');
  const [selectedListRevision, setSelectedListRevision] = useState(state.priorityLists.at(-1)?.revision ?? '');
  const [manualSelection, setManualSelection] = useState('');
  const [inspection, setInspection] = useState<PriorityListInspection | null>(null);
  const [identifierHeader, setIdentifierHeader] = useState('');
  const [rankHeader, setRankHeader] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const listInput = useRef<HTMLInputElement>(null);

  const activeRanking = draft.rankings.find((item) => item.id === draft.activeRankingId) ?? null;
  const orderedRecommendations = useMemo(
    () => activeRanking?.ranks.slice().sort((left, right) => compareNullableRanks(left, right, 'asc')) ?? [],
    [activeRanking],
  );
  const topRecommendation = orderedRecommendations.find((item) => item.rank !== null) ?? null;
  const contextMatchesSelection = draft.context?.targetRowIds.length === 1 && draft.context.targetRowIds[0] === targetId;
  const alternatives = dataset.rows.filter((row) => row.id !== targetId);

  const execute = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'The operation failed.'); }
    finally { setBusy(false); }
  };

  const decisionInputs = async () => {
    if (!targetId) throw new Error('Select the planned job that needs a replacement.');
    const evidenceDataset = await ensureEvidenceDataset();
    const context = createDecisionContext(evidenceDataset, 'JOB_REPLACEMENT', [targetId], new Date().toISOString().slice(0, 10));
    const scope = await createCandidateScope(evidenceDataset, context, {
      mode: 'ALL_RECORDS',
      rationale: 'Default replacement population includes every loaded planning record except the selected planned job. Data-quality state remains visible and advisory.',
    });
    return { evidenceDataset, context, scope };
  };

  const runRanking = (kind: 'priority' | 'reference' | 'model') => execute(async () => {
    const { evidenceDataset, context, scope } = await decisionInputs();
    let result: RankingResult;
    if (kind === 'priority') {
      const list = state.priorityLists.find((candidate) => candidate.revision === selectedListRevision);
      if (!list) throw new Error('Select a Priority List revision.');
      result = await rankByPriorityList(evidenceDataset, context.id, scope, null, list);
    } else if (kind === 'reference') {
      result = await rankByWeightedCriteria(evidenceDataset, context.id, scope, null);
    } else {
      result = await rankByDemonstrationModel(evidenceDataset, context.id, scope, null);
    }
    const rankings = [...draft.rankings.filter((existing) => existing.source.id !== result.source.id || existing.source.revision !== result.source.revision), result];
    onDraft({ ...draft, context, scope, ruleSet: null, eligibility: null, rankings, activeRankingId: result.id, myRank: [], portfolio: null, updatedAt: new Date().toISOString() });
    const ranked = result.ranks.filter((item) => item.rank !== null).length;
    setNotice(`${result.source.label} produced ${ranked} recommendation${ranked === 1 ? '' : 's'} across ${scope.candidateRowIds.length} scoped records. Eligibility was not used as a gate.`);
  });

  const runAdvisoryEligibility = () => execute(async () => {
    const { context, scope } = await decisionInputs();
    const evidenceDataset = await ensureEvidenceDataset();
    const ruleSet = await createRuleSet('Advisory deterministic review', defaultEligibilityRules());
    const eligibility = await evaluateEligibility(evidenceDataset, context, scope, ruleSet);
    onDraft({ ...draft, context, scope, ruleSet, eligibility, updatedAt: new Date().toISOString() });
    setNotice('Advisory eligibility evidence was evaluated. It did not alter the selected recommendation source or remove planning records.');
  });

  const createDemoList = () => execute(async () => {
    if (!dataset.grainColumnId) throw new Error('Select a dataset-grain column before creating a sample Priority List.');
    const entries = dataset.rows.map((row, index) => ({
      itemId: String(row.cells[dataset.grainColumnId!]?.currentRaw ?? '').trim(),
      priorityRank: index + 1,
      additionalFields: { Priority: semanticText(dataset, row.id, 'priority') },
    }));
    const list = await createPriorityListRevision('Synthetic demonstration priority list', 'Planned Job ID', 'Priority Rank', entries, 'independently-generated-in-application');
    const priorityLists = state.priorityLists.some((item) => item.revision === list.revision) ? state.priorityLists : [...state.priorityLists, list];
    onState({ ...state, priorityLists }); setSelectedListRevision(list.revision);
    setNotice('Synthetic Priority List revision created. It remains independent from eligibility and model output.');
  });

  const importList = () => execute(async () => {
    if (!inspection) throw new Error('Inspect a Priority List workbook first.');
    const prior = state.priorityLists.find((list) => list.name === inspection.sourceName.replace(/\.xlsx$/i, '') && list.sourceName === inspection.sourceName);
    const list = await createPriorityListFromInspection(inspection, inspection.sourceName.replace(/\.xlsx$/i, ''), identifierHeader, rankHeader, prior?.id);
    const priorityLists = state.priorityLists.some((item) => item.revision === list.revision) ? state.priorityLists : [...state.priorityLists, list];
    onState({ ...state, priorityLists }); setSelectedListRevision(list.revision); setInspection(null);
    setNotice(`Priority List revision imported with ${list.entries.filter((entry) => entry.status === 'VALID').length} valid and ${list.entries.filter((entry) => entry.status === 'INVALID').length} retained invalid entries.`);
  });

  const exportList = () => execute(async () => {
    const list = state.priorityLists.find((candidate) => candidate.revision === selectedListRevision);
    if (!list) throw new Error('Select a Priority List revision.');
    downloadBytes(await exportPriorityList(list), `erp-priority-list-${list.id}-${list.revision.slice(7, 15)}.xlsx`);
    setNotice('Priority List revision exported, including invalid source rows for correction.');
  });

  const accept = (selectedRowId: string, rankingResultId: string | null) => execute(async () => {
    let context = draft.context;
    let scope = draft.scope;
    let evidenceDataset = dataset;
    if (!context || !scope || !contextMatchesSelection || context.datasetSnapshotRevision !== dataset.snapshotRevision) {
      const prepared = await decisionInputs(); evidenceDataset = prepared.evidenceDataset; context = prepared.context; scope = prepared.scope;
    }
    if (selectedRowId === targetId) throw new Error('The planned job cannot replace itself.');
    const evidenceWorkbook = { ...workbook, sheets: workbook.sheets.map((sheet, index) => index === workbook.activeSheetIndex ? evidenceDataset : sheet) };
    const applicableRanking = rankingResultId ? draft.rankings.find((item) => item.id === rankingResultId) ?? null : null;
    const snapshot = {
      workbook: evidenceWorkbook,
      dataset: evidenceDataset,
      context,
      scope,
      ruleSet: draft.ruleSet,
      eligibility: draft.eligibility && draft.eligibility.scopeRevision === scope.revision ? draft.eligibility : null,
      rankings: applicableRanking ? [applicableRanking] : [],
      myRank: [], portfolio: null,
      relationships: [], historicalEvents: [],
    };
    const result = await recordReplacementDecision(state.cases, {
      name: `Replacement: ${rowLabel(evidenceDataset, targetId)} → ${rowLabel(evidenceDataset, selectedRowId)}`,
      snapshot, selectedRowId, rankingResultId: applicableRanking?.id ?? null,
      actorLabel: 'Local operator',
      reason: applicableRanking ? `Operator explicitly accepted the selected recommendation from ${applicableRanking.source.label}.` : 'Operator explicitly selected a manual alternative.',
    });
    if (result.created) onState({ ...state, cases: [...state.cases, result.planningCase] });
    setNotice(result.created ? 'Replacement decision recorded as an immutable Case. No feedback, training label, or outcome was created.' : 'This exact replacement decision was already recorded; no duplicate Case was created.');
  });

  const activeList = state.priorityLists.find((item) => item.revision === selectedListRevision) ?? null;
  return <section className="module-stack" aria-labelledby="recommendations-title">
    <div className="module-hero"><p className="eyebrow">Recommendations</p><h1 id="recommendations-title">Choose a replacement with the engineer in control.</h1><p>Priority Lists are the default operational source. Reference and model rankings are optional advisory views. Eligibility never silently removes loaded records.</p></div>
    <section className="panel recommendation-controls"><h2>1. Select the planned job</h2><label className="field-stack">Planned job<select value={targetId} onChange={(event) => { setTargetId(event.target.value); setManualSelection(''); }}><option value="">Select a planning record</option>{dataset.rows.map((row) => <option key={row.id} value={row.id}>{rowLabel(dataset, row.id)} · {row.readiness.replaceAll('_', ' ')}</option>)}</select></label></section>
    <section className="panel"><h2>2. Choose a recommendation source</h2><div className="panel-actions"><button className="button secondary" onClick={() => void createDemoList()} disabled={busy}>Create synthetic Priority List</button><button className="button secondary" onClick={() => listInput.current?.click()} disabled={busy}>Import Priority List (.xlsx)</button><button className="button secondary" onClick={() => void exportList()} disabled={busy || !activeList}>Export selected revision</button><input ref={listInput} className="sr-only" type="file" accept=".xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void execute(async () => { const inspected = await inspectPriorityListWorkbook(new Uint8Array(await file.arrayBuffer()), file.name); setInspection(inspected); setIdentifierHeader(inspected.headers[0] ?? ''); setRankHeader(inspected.headers[1] ?? ''); }); event.currentTarget.value = ''; }} /></div>
      {inspection && <div className="form-grid"><label>Item identifier column<select value={identifierHeader} onChange={(event) => setIdentifierHeader(event.target.value)}>{inspection.headers.map((header) => <option key={header}>{header}</option>)}</select></label><label>Priority Rank column<select value={rankHeader} onChange={(event) => setRankHeader(event.target.value)}>{inspection.headers.map((header) => <option key={header}>{header}</option>)}</select></label><button className="button primary" onClick={() => void importList()} disabled={busy}>Import mapped list</button></div>}
      <label className="field-stack">Priority List revision<select value={selectedListRevision} onChange={(event) => setSelectedListRevision(event.target.value)}><option value="">Select a Priority List</option>{state.priorityLists.map((list) => <option key={list.revision} value={list.revision}>{list.name} · {list.entries.filter((entry) => entry.status === 'VALID').length} valid · {list.revision.slice(7, 15)}</option>)}</select></label>
      {activeList && <p className={activeList.issues.length ? 'inline-help attention-text' : 'inline-help'}>{activeList.issues.length ? `${activeList.issues.length} source issue${activeList.issues.length === 1 ? '' : 's'} retained; affected rows are unranked.` : 'All list entries are valid.'} Logical ID {activeList.id}; immutable revision {activeList.revision.slice(0, 23)}…</p>}
      <div className="panel-actions"><button className="button primary" onClick={() => void runRanking('priority')} disabled={busy || !targetId || !selectedListRevision}>Apply Priority List</button><button className="button secondary" onClick={() => void runRanking('reference')} disabled={busy || !targetId}>Run optional reference ranking</button><button className="button secondary" onClick={() => void runRanking('model')} disabled={busy || !targetId}>Run optional synthetic model</button></div>
    </section>
    <section className="panel recommendation-result"><h2>3. Review and decide</h2>{!activeRanking ? <p>No recommendation source has been applied. You can still select a manual alternative below.</p> : <><p><strong>Active source:</strong> {activeRanking.source.label} <span className="status-chip neutral">{activeRanking.source.type.replaceAll('_', ' ')}</span></p>{topRecommendation ? <div className="top-recommendation"><span className="eyebrow">#1 recommendation</span><h3>{rowLabel(dataset, topRecommendation.rowId)}</h3><p>{topRecommendation.explanation.join(' ')}</p><button className="button primary accept-replacement" onClick={() => void accept(topRecommendation.rowId, activeRanking.id)} disabled={busy || !contextMatchesSelection}>Accept #1 as Replacement</button>{!contextMatchesSelection && <p className="inline-help">Re-apply a recommendation source after changing the planned job.</p>}</div> : <p className="notice info">This source produced no ranked candidate. Loaded records remain available for manual selection.</p>}<details><summary>Remaining recommendations and evidence</summary><div className="evidence-table-wrap"><table><thead><tr><th>Priority / source rank</th><th>Planning record</th><th>Advisory state</th><th>Explanation</th></tr></thead><tbody>{orderedRecommendations.map((rank) => { const advisory = draft.eligibility?.evaluations.find((item) => item.rowId === rank.rowId); return <tr key={rank.rowId}><td>{rank.rank ?? 'Unranked'}</td><td>{rowLabel(dataset, rank.rowId)}</td><td>{advisory?.state ?? 'Not evaluated'}</td><td>{rank.explanation.join(' ')}</td></tr>; })}</tbody></table></div></details></>}
      <div className="manual-alternative"><h3>Manual alternative</h3><label>Replacement record<select value={manualSelection} onChange={(event) => setManualSelection(event.target.value)}><option value="">Select any other loaded record</option>{alternatives.map((row) => <option key={row.id} value={row.id}>{rowLabel(dataset, row.id)} · {row.readiness.replaceAll('_', ' ')}</option>)}</select></label><button className="button secondary" onClick={() => void accept(manualSelection, null)} disabled={busy || !manualSelection || !targetId}>Record Manual Replacement</button></div>
    </section>
    <details className="panel secondary-analysis"><summary>Secondary analysis: Candidate Scope and advisory eligibility</summary><p>The default scope contains all {Math.max(0, dataset.rows.length - 1)} other loaded records. Validation and eligibility remain visible evidence; they do not override an explicit engineer decision.</p><button className="button secondary" onClick={() => void runAdvisoryEligibility()} disabled={busy || !targetId}>Run advisory eligibility review</button>{draft.eligibility && <div className="state-summary">{['ELIGIBLE','INELIGIBLE','INFEASIBLE','REVIEW_REQUIRED','INVALID'].map((value) => <span key={value}><b>{draft.eligibility!.evaluations.filter((item) => item.state === value).length}</b>{value.replaceAll('_', ' ')}</span>)}</div>}</details>
    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status">{notice}</div>}
  </section>;
}
