import { useEffect, useRef, useState } from 'react';
import type { DecisionDraft, PersistedApplicationState, PlanningDataset, SavedWorkspace, WorkbookState } from '../contracts';
import { createSyntheticFacilitiesDataset, createSyntheticPlanningDataset, emptyApplicationState, exportApplicationBackup, importApplicationBackup, stampWorkbookRevisions, workbookHasUnsavedChanges } from '../core';
import { CasesWorkspace } from './components/CasesWorkspace';
import { DashboardWorkspace } from './components/DashboardWorkspace';
import { DecisionWorkspace } from './components/DecisionWorkspace';
import { MappingPanel } from './components/MappingPanel';
import { PlanningGrid } from './components/PlanningGrid';
import { RecommendationsWorkspace } from './components/RecommendationsWorkspace';
import { ValidationPanel } from './components/ValidationPanel';
import { clearApplicationStorage, loadApplicationState, saveApplicationState } from './adapters/indexed-db';

type Notice = { kind: 'success' | 'error' | 'info'; message: string } | null;
type View = 'data' | 'recommendations' | 'portfolio' | 'cases' | 'dashboard';

function emptyDraft(workspaceId: string): DecisionDraft {
  return { workspaceId, context: null, scope: null, ruleSet: null, eligibility: null, rankings: [], activeRankingId: null, myRank: [], portfolio: null, updatedAt: new Date().toISOString() };
}

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}

export function App() {
  const [application, setApplication] = useState<PersistedApplicationState>(emptyApplicationState());
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [storageWritable, setStorageWritable] = useState(false);
  const [storageStatus, setStorageStatus] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
  const [activeView, setActiveView] = useState<View>('data');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const workspace = application.workspaces.find((item) => item.id === application.activeWorkspaceId) ?? null;
  const workbook = workspace?.workbook ?? null;
  const dataset = workbook?.sheets[workbook.activeSheetIndex] ?? null;
  const draft = workspace ? application.decisionDrafts.find((item) => item.workspaceId === workspace.id) ?? emptyDraft(workspace.id) : null;

  useEffect(() => {
    void loadApplicationState().then((state) => { setApplication(state); setStorageWritable(true); setStorageStatus('saved'); setStorageLoaded(true); }).catch((error) => {
      setStorageLoaded(true); setStorageStatus('error'); setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Local state could not be restored.' });
    });
  }, []);

  useEffect(() => {
    if (!storageLoaded || !storageWritable) return;
    setStorageStatus('saving');
    const timeout = window.setTimeout(() => {
      void saveApplicationState(application).then(() => setStorageStatus('saved')).catch((error) => { setStorageStatus('error'); setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Local state could not be saved.' }); });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [application, storageLoaded, storageWritable]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (storageStatus !== 'saving' && !workbookHasUnsavedChanges(workbook)) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [workbook, storageStatus]);

  const commitApplication = (next: PersistedApplicationState) => setApplication({ ...next, lastCommittedAt: new Date().toISOString() });
  const updateWorkbook = (nextWorkbook: WorkbookState, clearDecision = false) => {
    if (!workspace) return;
    setApplication((current) => ({ ...current, lastCommittedAt: new Date().toISOString(), workspaces: current.workspaces.map((item) => item.id === workspace.id ? { ...item, workbook: nextWorkbook, savedAt: new Date().toISOString() } : item), decisionDrafts: clearDecision ? current.decisionDrafts.filter((item) => item.workspaceId !== workspace.id) : current.decisionDrafts }));
  };
  const replaceActiveDataset = (next: PlanningDataset) => {
    if (!workbook || !workspace) return;
    const revisionChanged = !!draft?.context && next.snapshotRevision !== draft.context.datasetSnapshotRevision;
    updateWorkbook({ ...workbook, sheets: workbook.sheets.map((sheet, index) => index === workbook.activeSheetIndex ? next : sheet) }, revisionChanged);
  };
  const addWorkspace = async (name: string, nextWorkbook: WorkbookState) => {
    const stamped = await stampWorkbookRevisions(nextWorkbook);
    const id = `workspace-${crypto.randomUUID()}`;
    const saved: SavedWorkspace = { id, name, workbook: stamped, savedAt: new Date().toISOString() };
    commitApplication({ ...application, workspaces: [...application.workspaces, saved], activeWorkspaceId: id, decisionDrafts: [...application.decisionDrafts, emptyDraft(id)] });
    setActiveView('data');
  };
  const loadSample = (kind: 'maintenance' | 'facilities') => {
    setBusy(true); const sample = kind === 'maintenance' ? createSyntheticPlanningDataset() : createSyntheticFacilitiesDataset();
    void addWorkspace(sample.sourceName, { sourceName: sample.sourceName, sourceIdentity: sample.sourceIdentity, sheets: [sample], activeSheetIndex: 0 }).then(() => setNotice({ kind: 'success', message: `${sample.sourceName} loaded as a new persistent synthetic workspace.` })).catch((error) => setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Synthetic workspace could not be created.' })).finally(() => setBusy(false));
  };
  const importFile = async (file: File) => {
    setBusy(true); setNotice({ kind: 'info', message: `Inspecting ${file.name} locally…` });
    try {
      const { readPlanningWorkbook } = await import('./adapters/excel');
      const parsed = await readPlanningWorkbook(new Uint8Array(await file.arrayBuffer()), file.name);
      await addWorkspace(file.name, parsed);
      setNotice({ kind: 'success', message: `${file.name} loaded as a new workspace with ${parsed.sheets.length} visible sheet${parsed.sheets.length === 1 ? '' : 's'}. Existing workspaces were preserved.` });
    } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Workbook import failed.' }); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ''; }
  };
  const ensureEvidenceDataset = async (): Promise<PlanningDataset> => {
    if (!workbook) throw new Error('Load a planning workspace first.');
    const stamped = await stampWorkbookRevisions(workbook); updateWorkbook(stamped); return stamped.sheets[stamped.activeSheetIndex];
  };
  const updateDraft = (next: DecisionDraft) => setApplication((current) => ({ ...current, lastCommittedAt: new Date().toISOString(), decisionDrafts: [...current.decisionDrafts.filter((item) => item.workspaceId !== next.workspaceId), next] }));
  const exportWorkbook = async () => {
    if (!workbook) return; setBusy(true); setNotice({ kind: 'info', message: 'Creating a local Planning Workbook…' });
    try {
      const { preparePlanningWorkbook, downloadBytes, planningWorkbookFilename } = await import('./adapters/excel');
      const exported = await preparePlanningWorkbook(workbook); downloadBytes(exported.bytes, planningWorkbookFilename(exported.workbook)); updateWorkbook(exported.workbook);
      setNotice({ kind: 'success', message: `Full Planning Workbook exported with ${exported.workbook.sheets.length} worksheet${exported.workbook.sheets.length === 1 ? '' : 's'}.` });
    } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Workbook export failed.' }); } finally { setBusy(false); }
  };
  const exportBackup = () => void exportApplicationBackup(application).then((text) => downloadText(text, `erp-local-backup-${new Date().toISOString().slice(0,10)}.json`)).catch((error)=>setNotice({kind:'error',message:error instanceof Error?error.message:'Backup failed.'}));
  const importBackup = (file: File) => {
    if (file.size > 50 * 1024 * 1024) { setNotice({kind:'error',message:'Application backup exceeds the 50 MB import limit.'}); return; }
    void file.text().then(importApplicationBackup).then((state)=>{setStorageWritable(true);commitApplication(state);setNotice({kind:'success',message:'Application backup restored after schema and integrity validation.'});}).catch((error)=>setNotice({kind:'error',message:error instanceof Error?error.message:'Backup restore failed.'}));
  };
  const deleteWorkspace = () => {
    if (!workspace || !window.confirm(`Delete local workspace “${workspace.name}”? Export a backup first if it must be recoverable.`)) return;
    const remaining = application.workspaces.filter((item)=>item.id!==workspace.id);
    commitApplication({ ...application, workspaces: remaining, activeWorkspaceId: remaining[0]?.id??null, decisionDrafts: application.decisionDrafts.filter((item)=>item.workspaceId!==workspace.id) });
  };
  const clearAll = () => {
    if (!window.confirm('Delete every local ERP workspace, Priority List, Case, scenario, and saved view? This cannot be undone without an exported backup.')) return;
    void clearApplicationStorage().then(()=>{setStorageWritable(true);setStorageStatus('saved');setApplication(emptyApplicationState());setNotice({kind:'success',message:'All local ERP application data was deleted.'});}).catch((error)=>setNotice({kind:'error',message:error instanceof Error?error.message:'Local data could not be deleted.'}));
  };
  const nav: Array<[View,string]> = [['data','Planning Data'],['recommendations','Recommendations'],['portfolio','Portfolio'],['cases','Cases'],['dashboard','Dashboard']];
  if (!storageLoaded) return <main className="loading-screen"><h1>Enterprise Resource Planner</h1><p>Restoring local application state…</p></main>;

  return <div className="app-shell"><a className="skip-link" href="#workspace">Skip to active workspace</a>
    <header className="topbar"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">ER</span><div><strong>Enterprise Resource Planner</strong><span>Operational planning and decision evidence</span></div></div><div className="topbar-status"><span className={`local-indicator ${storageStatus}`}><span aria-hidden="true"/>{storageStatus==='saved'?'Saved locally':storageStatus==='saving'?'Saving locally…':storageStatus==='error'?'Local save error':'Loading local state'}</span><span>No telemetry</span></div></header>
    <nav className="primary-nav" aria-label="Primary">{nav.map(([view,label])=><button key={view} className={activeView===view?'active':''} aria-current={activeView===view?'page':undefined} onClick={()=>setActiveView(view)} disabled={!dataset&&view!=='data'}>{label}</button>)}</nav>
    <div className="workspace-switcher"><label>Workspace<select value={application.activeWorkspaceId??''} onChange={(event)=>{commitApplication({...application,activeWorkspaceId:event.target.value||null});setActiveView('data');}}><option value="">No active workspace</option>{application.workspaces.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="button secondary" disabled={!workspace} onClick={deleteWorkspace}>Delete workspace</button><button className="button secondary" onClick={exportBackup}>Export local backup</button><button className="button secondary" onClick={()=>backupInputRef.current?.click()}>Restore backup</button><input ref={backupInputRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event)=>{const file=event.target.files?.[0];if(file)importBackup(file);event.currentTarget.value='';}}/><button className="button danger" onClick={clearAll}>Delete all local data</button></div>
    <main id="workspace" className="workspace">{notice&&<div className={`notice ${notice.kind}`} role={notice.kind==='error'?'alert':'status'}>{notice.message}</div>}
      {activeView==='data'&&<PlanningDataView workspace={workspace} workbook={workbook} dataset={dataset} busy={busy} inputRef={inputRef} loadSample={loadSample} importFile={importFile} updateWorkbook={updateWorkbook} replaceActiveDataset={replaceActiveDataset} exportWorkbook={exportWorkbook}/>}
      {dataset&&workbook&&workspace&&draft&&activeView==='recommendations'&&<RecommendationsWorkspace dataset={dataset} workbook={workbook} workspaceId={workspace.id} state={application} draft={draft} ensureEvidenceDataset={ensureEvidenceDataset} onDraft={updateDraft} onState={commitApplication}/>}
      {dataset&&workbook&&workspace&&draft&&activeView==='portfolio'&&<DecisionWorkspace view="portfolio" dataset={dataset} workbook={workbook} workspaceId={workspace.id} state={application} draft={draft} ensureEvidenceDataset={ensureEvidenceDataset} onDraft={updateDraft} onState={commitApplication}/>}
      {dataset&&workbook&&draft&&activeView==='cases'&&<CasesWorkspace state={application} draft={draft} dataset={dataset} workbook={workbook} onState={commitApplication}/>}
      {dataset&&draft&&activeView==='dashboard'&&<DashboardWorkspace dataset={dataset} draft={draft} state={application}/>}
    </main><footer><span>ERP · local static browser application</span><span>IndexedDB is local browser storage, not encrypted backup or synchronization · export backups deliberately</span></footer></div>;
}

interface DataViewProps { workspace: SavedWorkspace|null; workbook: WorkbookState|null; dataset: PlanningDataset|null; busy:boolean; inputRef: React.RefObject<HTMLInputElement|null>; loadSample:(kind:'maintenance'|'facilities')=>void; importFile:(file:File)=>Promise<void>; updateWorkbook:(workbook:WorkbookState,clearDecision?:boolean)=>void; replaceActiveDataset:(dataset:PlanningDataset)=>void; exportWorkbook:()=>Promise<void>; }
function PlanningDataView({ workspace, workbook, dataset, busy, inputRef, loadSample, importFile, updateWorkbook, replaceActiveDataset, exportWorkbook }: DataViewProps) {
  return <><section className="workspace-intro"><div><p className="eyebrow">Planning Data Workbench</p><h1>Prepare operational data without losing its source meaning.</h1><p>Load a public-safe sample or inspect an XLSX workbook locally. Each import becomes an independent persistent workspace.</p></div><div className="workflow-strip" aria-label="Workbench workflow">{['Open','Inspect','Map','Validate','Edit','Export'].map((step,index)=><span key={step}><b>{index+1}</b>{step}</span>)}</div></section>
    <section className="panel intake-panel"><div className="panel-heading"><div><p className="eyebrow">Open</p><h2>Create a planning workspace</h2><p>No file content is transmitted. Existing local workspaces are preserved.</p></div></div><div className="intake-actions"><button className="button primary" onClick={()=>loadSample('maintenance')} disabled={busy}>Load maintenance sample</button><button className="button secondary" onClick={()=>loadSample('facilities')} disabled={busy}>Load facilities sample</button><button className="button secondary" onClick={()=>inputRef.current?.click()} disabled={busy}>Import Excel (.xlsx)</button><input ref={inputRef} className="sr-only" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event)=>{const file=event.target.files?.[0];if(file)void importFile(file);}}/><span className="inline-help">10 MB compressed · 20,000 rows/sheet · macros rejected</span></div></section>
    {!dataset||!workbook||!workspace?<section className="empty-state"><div className="empty-icon" aria-hidden="true">▦</div><h2>No planning workspace selected</h2><p>Load a reproducible synthetic plan, import XLSX, or restore an application backup.</p></section>:<><section className="dataset-bar"><div><span>Active workspace</span><strong>{workspace.name}</strong></div>{workbook.sheets.length>1?<label>Worksheet<select value={workbook.activeSheetIndex} onChange={(event)=>updateWorkbook({...workbook,activeSheetIndex:Number(event.target.value)})}>{workbook.sheets.map((sheet,index)=><option key={sheet.id} value={index}>{sheet.sheetName}</option>)}</select></label>:<span className="sheet-name">Sheet: {dataset.sheetName}</span>}<div className="dataset-facts"><span>{dataset.synthetic?'Synthetic':'Imported'}</span><span>{dataset.rows.length} rows</span><span>{dataset.columns.length} columns</span><span>{dataset.readiness.replaceAll('_',' ').toLocaleLowerCase('en-US')}</span></div></section><MappingPanel dataset={dataset} onChange={replaceActiveDataset}/><ValidationPanel dataset={dataset}/><PlanningGrid key={`${workbook.sourceIdentity}:${dataset.id}`} dataset={dataset} onChange={replaceActiveDataset}/><section className="panel export-panel"><div><p className="eyebrow">Export</p><h2>Export full Planning Workbook</h2><p>Exports all worksheets, edits, mappings, grain, provenance, and revision evidence.</p></div><button className="button primary" onClick={()=>void exportWorkbook()} disabled={busy}>Export full workbook (.xlsx)</button></section></>}
  </>;
}
