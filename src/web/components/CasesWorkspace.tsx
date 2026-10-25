import { useRef, useState } from 'react';
import type { DecisionDraft, HumanEventType, PersistedApplicationState, PlanningDataset, WorkbookState } from '../../contracts';
import {
  appendHumanEvent,
  createPlanningCase,
  evaluateScenario,
  exportPortableCase,
  importPortableCase,
  historicalEventsAtCutoff,
  semanticText,
  validateRelationships,
  verifyPlanningCase,
} from '../../core';

interface Props {
  state: PersistedApplicationState;
  draft: DecisionDraft;
  dataset: PlanningDataset;
  workbook: WorkbookState;
  onState: (state: PersistedApplicationState) => void;
}
function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}
function rowLabel(dataset: PlanningDataset, rowId: string): string {
  return semanticText(dataset, rowId, 'planned_job_identifier') || semanticText(dataset, rowId, 'asset_identifier') || rowId;
}

function eventValueSummary(type: HumanEventType, value: string): string {
  if (type !== 'MY_RANK_SAVED') return value;
  try { const ranks = JSON.parse(value) as unknown[]; return `${Array.isArray(ranks) ? ranks.length : 0} ranked rows saved in the immutable Case event.`; }
  catch { return 'Saved My Rank evidence is not displayable.'; }
}

export function CasesWorkspace({ state, draft, dataset, workbook, onState }: Props) {
  const [selectedCaseId, setSelectedCaseId] = useState(state.cases[0]?.id ?? '');
  const [caseName, setCaseName] = useState('Planning decision');
  const [actor, setActor] = useState('Local operator');
  const [eventType, setEventType] = useState<HumanEventType>('DECISION_RECORDED');
  const [eventValue, setEventValue] = useState('');
  const [reason, setReason] = useState('');
  const [supersedes, setSupersedes] = useState('');
  const [scenarioName, setScenarioName] = useState('Alternative assumptions');
  const [scenarioBudget, setScenarioBudget] = useState('');
  const [scenarioRankingId, setScenarioRankingId] = useState('');
  const [scenarioCandidateIds, setScenarioCandidateIds] = useState<string[]>([]);
  const [relationshipFrom, setRelationshipFrom] = useState('');
  const [relationshipTo, setRelationshipTo] = useState('');
  const [relationshipType, setRelationshipType] = useState('depends-on');
  const [relationshipFromDate, setRelationshipFromDate] = useState('');
  const [relationshipToDate, setRelationshipToDate] = useState('');
  const [historyEntity, setHistoryEntity] = useState('');
  const [historyType, setHistoryType] = useState('inspection');
  const [historyDate, setHistoryDate] = useState(new Date().toISOString().slice(0,10));
  const [historyValue, setHistoryValue] = useState('');
  const [historyCutoff, setHistoryCutoff] = useState(new Date().toISOString().slice(0,10));
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = state.cases.find((item) => item.id === selectedCaseId) ?? null;

  const execute = async (operation: () => Promise<void>) => {
    setError(''); setStatus('');
    try { await operation(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Case operation failed.'); }
  };

  const snapshot = () => {
    if (!draft.context || !draft.scope) throw new Error('Select a planned item and materialize a Candidate Scope before recording a Case.');
    if (!dataset.snapshotRevision || dataset.snapshotRevision !== draft.context.datasetSnapshotRevision) throw new Error('The active dataset no longer matches the decision evidence.');
    const cutoff = draft.context.effectiveDate;
    const relationships = state.relationships.filter((record) => (!record.effectiveFrom || record.effectiveFrom <= cutoff) && (!record.effectiveTo || record.effectiveTo >= cutoff));
    return { workbook, dataset, context: draft.context, scope: draft.scope, ruleSet: draft.ruleSet, eligibility: draft.eligibility, rankings: draft.rankings, myRank: draft.myRank, portfolio: draft.portfolio, relationships, historicalEvents: historicalEventsAtCutoff(state.historicalEvents, cutoff) };
  };

  const recordCase = () => execute(async () => {
    let planningCase = await createPlanningCase(caseName, snapshot());
    if (draft.myRank.length) planningCase = await appendHumanEvent(planningCase, { type: 'MY_RANK_SAVED', actorLabel: actor, value: JSON.stringify(draft.myRank), reason: 'Operator explicitly saved My Rank with the Case.' });
    onState({ ...state, cases: [...state.cases, planningCase] });
    setSelectedCaseId(planningCase.id);
    setStatus(`“${planningCase.name}” saved to History.`);
  });

  const recordEvent = () => execute(async () => {
    if (!selected) throw new Error('Select a Case.');
    const updated = await appendHumanEvent(selected, { type: eventType, actorLabel: actor, value: eventValue, reason, supersedesEventId: supersedes || null });
    onState({ ...state, cases: state.cases.map((item) => item.id === updated.id ? updated : item) });
    setEventValue(''); setReason(''); setSupersedes('');
    setStatus('History entry saved.');
  });

  const branch = () => execute(async () => {
    if (!selected) throw new Error('Select a parent Case.');
    const budget = scenarioBudget === '' ? undefined : Number(scenarioBudget);
    if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) throw new Error('Scenario budget must be non-negative.');
    const { scenario, planningCase } = await evaluateScenario(selected, scenarioName, {
      budget,
      rankingResultId: scenarioRankingId || undefined,
      candidateRowIds: scenarioCandidateIds.length ? scenarioCandidateIds : undefined,
      notes: 'Scenario values are assumptions, not observed outcomes.',
    });
    onState({ ...state, scenarios: [...state.scenarios, scenario], cases: [...state.cases, planningCase] });
    setSelectedCaseId(planningCase.id);
    setStatus(`Scenario “${scenario.name}” evaluated. No final decision was recorded.`);
  });

  const exportCase = () => execute(async () => {
    if (!selected) throw new Error('Select a Case.');
    downloadText(await exportPortableCase(selected), `erp-case-${selected.id}.json`);
    setStatus('Decision record exported.');
  });

  const importCase = (file: File) => execute(async () => {
    if (file.size > 10 * 1024 * 1024) throw new Error('Portable Case exceeds the 10 MB import limit.');
    const planningCase = await importPortableCase(await file.text());
    if (state.cases.some((item) => item.id === planningCase.id && item.revision === planningCase.revision)) throw new Error('This exact Case revision already exists locally.');
    onState({ ...state, cases: [...state.cases.filter((item) => item.id !== planningCase.id), planningCase] });
    setSelectedCaseId(planningCase.id);
    setStatus(`Decision record “${planningCase.name}” imported.`);
  });

  const addRelationship = () => execute(async () => {
    if (!relationshipFrom.trim() || !relationshipTo.trim() || !relationshipType.trim()) throw new Error('Relationship endpoints and type are required.');
    const record = { relationshipId:`relationship-${crypto.randomUUID()}`, fromEntityId:relationshipFrom.trim(), toEntityId:relationshipTo.trim(), relationshipType:relationshipType.trim(), effectiveFrom:relationshipFromDate||null, effectiveTo:relationshipToDate||null, provenance:{kind:'USER_ENTERED' as const,source:'explicit-local-entry'} };
    const next = [...state.relationships,record];
    const issues = validateRelationships(next); if (issues.length) throw new Error(issues.join(' '));
    onState({...state,relationships:next}); setStatus('Relationship record saved with stable identity and explicit provenance.');
  });

  const addHistoricalEvent = () => execute(async () => {
    if (!historyEntity.trim() || !historyType.trim() || !historyDate || !historyValue.trim()) throw new Error('Historical event entity, type, date, and value are required.');
    const event = {eventId:`history-${crypto.randomUUID()}`,entityId:historyEntity.trim(),eventType:historyType.trim(),occurredAt:historyDate,value:historyValue.trim(),provenance:{kind:'OBSERVED' as const,source:'explicit-local-entry'}};
    onState({...state,historicalEvents:[...state.historicalEvents,event]}); setHistoryValue(''); setStatus('Historical event saved. Future decision Cases apply their explicit as-of cutoff.');
  });

  const visibleHistory = historicalEventsAtCutoff(state.historicalEvents,historyCutoff);

  return <section className="module-stack" aria-labelledby="cases-title">
    <div className="page-header"><div><p className="eyebrow">History</p><h1 id="cases-title">Decisions and scenarios</h1><p>Review saved replacements, record outcomes, or explore a separate scenario.</p></div></div>
    <div className="history-layout"><section className="panel"><h2>Save current analysis</h2><div className="form-grid"><label>Name<input value={caseName} onChange={(event)=>setCaseName(event.target.value)}/></label><label>Recorded by<input value={actor} onChange={(event)=>setActor(event.target.value)}/></label></div><button className="button primary" onClick={()=>void recordCase()}>Save analysis{draft.myRank.length?' with My Rank':''}</button></section>
    <section className="panel"><h2>Saved decisions</h2><label className="field-stack">Saved item<select value={selectedCaseId} onChange={(event)=>setSelectedCaseId(event.target.value)}><option value="">No item selected</option>{state.cases.map((item)=><option key={`${item.id}:${item.revision}`} value={item.id}>{item.name} · {item.events.length} events</option>)}</select></label><div className="panel-actions"><button className="button secondary" onClick={()=>void exportCase()} disabled={!selected}>Export record</button><button className="button secondary" onClick={()=>inputRef.current?.click()}>Import record</button><input ref={inputRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event)=>{const file=event.target.files?.[0];if(file)void importCase(file);event.currentTarget.value='';}}/></div>
      {selected&&<CaseReplay selected={selected}/>}</section>
    </div><details className="workbench-details"><summary>Add notes, feedback, or outcomes</summary><div className="drawer-content"><div className="form-grid"><label>Action<select value={eventType} onChange={(event)=>setEventType(event.target.value as HumanEventType)}><option value="DECISION_RECORDED">Record decision</option><option value="FEEDBACK_RECORDED">Record feedback</option><option value="OUTCOME_RECORDED">Record outcome</option><option value="EVIDENCE_CORRECTED">Correct a record</option><option value="MY_RANK_SAVED">Save My Rank</option></select></label><label>Value<input value={eventValue} onChange={(event)=>setEventValue(event.target.value)}/></label><label className="wide">Reason<textarea value={reason} onChange={(event)=>setReason(event.target.value)}/></label>{eventType==='EVIDENCE_CORRECTED'&&<label>Earlier event<select value={supersedes} onChange={(event)=>setSupersedes(event.target.value)}><option value="">Select original event</option>{selected?.events.map((event)=><option key={event.id} value={event.id}>{event.type} · {event.occurredAt}</option>)}</select></label>}</div><button className="button primary" onClick={()=>void recordEvent()} disabled={!selected}>Save entry</button></div></details>
    <details className="workbench-details"><summary>Scenarios</summary><div className="drawer-content"><p className="inline-help">A scenario uses the selected saved analysis. It does not record a final decision.</p><div className="form-grid"><label>Scenario name<input value={scenarioName} onChange={(event)=>setScenarioName(event.target.value)}/></label><label>Budget override<input type="number" min="0" value={scenarioBudget} onChange={(event)=>setScenarioBudget(event.target.value)} placeholder="Use saved budget"/></label><label>Ranking source<select value={scenarioRankingId} onChange={(event)=>setScenarioRankingId(event.target.value)}><option value="">Use saved source</option>{selected?.snapshot.rankings.map((ranking)=><option key={ranking.id} value={ranking.id}>{ranking.source.label}</option>)}</select></label><label className="wide">Candidate set override<select multiple size={6} value={scenarioCandidateIds} onChange={(event)=>setScenarioCandidateIds([...event.currentTarget.selectedOptions].map((option)=>option.value))}>{selected?.snapshot.scope.candidateRowIds.map((rowId)=><option key={rowId} value={rowId}>{rowLabel(selected.snapshot.dataset,rowId)}</option>)}</select></label></div><button className="button secondary" onClick={()=>void branch()} disabled={!selected}>Evaluate scenario</button></div></details>
    <details className="workbench-details"><summary>Related history</summary><div className="drawer-content"><h3>Add relationship</h3><div className="form-grid"><label>From entity<input value={relationshipFrom} onChange={(event)=>setRelationshipFrom(event.target.value)}/></label><label>Relationship type<input value={relationshipType} onChange={(event)=>setRelationshipType(event.target.value)}/></label><label>To entity<input value={relationshipTo} onChange={(event)=>setRelationshipTo(event.target.value)}/></label><label>Effective from<input type="date" value={relationshipFromDate} onChange={(event)=>setRelationshipFromDate(event.target.value)}/></label><label>Effective to<input type="date" value={relationshipToDate} onChange={(event)=>setRelationshipToDate(event.target.value)}/></label></div><button className="button secondary" onClick={()=>void addRelationship()}>Save relationship</button><ul>{state.relationships.map((record)=><li key={record.relationshipId}>{record.fromEntityId} — {record.relationshipType} → {record.toEntityId} ({record.effectiveFrom??'open'} to {record.effectiveTo??'open'})</li>)}</ul>
      <h3>Add observed event</h3><div className="form-grid"><label>Entity<input value={historyEntity} onChange={(event)=>setHistoryEntity(event.target.value)}/></label><label>Event type<input value={historyType} onChange={(event)=>setHistoryType(event.target.value)}/></label><label>Occurred on<input type="date" value={historyDate} onChange={(event)=>setHistoryDate(event.target.value)}/></label><label>Observed value<input value={historyValue} onChange={(event)=>setHistoryValue(event.target.value)}/></label></div><button className="button secondary" onClick={()=>void addHistoricalEvent()}>Save observed event</button><label className="field-stack">History as of<input type="date" value={historyCutoff} onChange={(event)=>setHistoryCutoff(event.target.value)}/></label><ul>{visibleHistory.map((event)=><li key={event.eventId}>{event.occurredAt} · {event.entityId} · {event.eventType}: {event.value}</li>)}</ul></div></details>
    {error&&<div className="notice error" role="alert">{error}</div>}{status&&<div className="notice success" role="status">{status}</div>}
  </section>;
}

function CaseReplay({ selected }: { selected: PersistedApplicationState['cases'][number] }) {
  const [integrity, setIntegrity] = useState<'unchecked'|'valid'|'invalid'>('unchecked');
  const decision = selected.events.find((event) => event.type === 'DECISION_RECORDED');
  let chosen = 'No replacement recorded';
  let planned = selected.snapshot.context.targetRowIds.map((id) => rowLabel(selected.snapshot.dataset, id)).join(', ');
  if (decision) { try { const value = JSON.parse(decision.value) as { selectedRowId?: string }; if (value.selectedRowId) chosen = rowLabel(selected.snapshot.dataset, value.selectedRowId); } catch { chosen = 'Decision record needs review'; } }
  return <div className="case-replay"><h3>Decision summary</h3><dl><div><dt>Job replaced</dt><dd>{planned}</dd></div><div><dt>Replacement</dt><dd>{chosen}</dd></div><div><dt>Recorded</dt><dd>{decision?.occurredAt ?? selected.createdAt}</dd></div><div><dt>Ranking source</dt><dd>{selected.snapshot.rankings.map((ranking)=>ranking.source.label).join(', ')||'Manual selection'}</dd></div></dl><details><summary>Audit details</summary><dl><div><dt>Planning data revision</dt><dd>{selected.snapshot.context.datasetSnapshotRevision}</dd></div><div><dt>Candidate rows</dt><dd>{selected.snapshot.scope.candidateRowIds.length}</dd></div><div><dt>Events</dt><dd>{selected.events.length}</dd></div><div><dt>Scenario parent</dt><dd>{selected.parentCaseId??'Base analysis'}</dd></div></dl><button className="button secondary" onClick={()=>void verifyPlanningCase(selected).then((valid)=>setIntegrity(valid?'valid':'invalid'))}>Verify record</button><span className={`status-chip ${integrity==='valid'?'success':integrity==='invalid'?'error':'neutral'}`}>{integrity==='unchecked'?'Not checked':integrity}</span><ol className="event-timeline">{selected.events.map((event)=><li key={event.id}><strong>{event.type.replaceAll('_',' ')}</strong><span>{eventValueSummary(event.type,event.value)}</span><small>{event.actorLabel} · {event.occurredAt} · {event.reason}</small></li>)}</ol></details></div>;
}
