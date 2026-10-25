import { useEffect, useRef, useState } from 'react';
import type { DecisionDraft, PersistedApplicationState, PlanningDataset, SavedWorkspace, WorkbookState } from '../contracts';
import { createSyntheticFacilitiesDataset, createSyntheticPlanningDataset, emptyApplicationState, exportApplicationBackup, importApplicationBackup, stampWorkbookRevisions, workbookHasUnsavedChanges } from '../core';
import { clearApplicationStorage, loadApplicationState, saveApplicationState } from './adapters/indexed-db';
import { DashboardWorkspace } from './components/DashboardWorkspace';
import { DecisionWorkspace } from './components/DecisionWorkspace';
import { CasesWorkspace } from './components/CasesWorkspace';
import { MappingPanel } from './components/MappingPanel';
import { PlanningGrid } from './components/PlanningGrid';
import { RecommendationsWorkspace } from './components/RecommendationsWorkspace';
import { ValidationPanel } from './components/ValidationPanel';
import './styles.css';

type View = 'data' | 'recommendations' | 'portfolio' | 'cases' | 'dashboard';
type Theme = 'dark' | 'light';
type Notice = { type: 'success' | 'error' | 'info'; message: string } | null;

const SAMPLE_LABELS: Record<string, string> = {
  'erp-synthetic-industrial-maintenance-v1': 'Maintenance example',
  'erp-synthetic-facilities-scheduling-v1': 'Facilities example',
};

function datasetDisplayName(dataset: PlanningDataset | null): string {
  if (!dataset) return 'No plan loaded';
  return SAMPLE_LABELS[dataset.sourceName] ?? dataset.sourceName.replace(/\.(xlsx|xlsm|csv)$/i, '');
}
function workbookFromDataset(dataset: PlanningDataset): WorkbookState { return { sourceName: dataset.sourceName, sourceIdentity: dataset.sourceIdentity, sheets: [dataset], activeSheetIndex: 0 }; }
function currentDataset(workspace: SavedWorkspace | null) { return workspace?.workbook.sheets[workspace.workbook.activeSheetIndex] ?? null; }
function withDataset(workspace: SavedWorkspace, dataset: PlanningDataset): SavedWorkspace { return { ...workspace, workbook: { ...workspace.workbook, sheets: workspace.workbook.sheets.map((sheet, index) => index === workspace.workbook.activeSheetIndex ? dataset : sheet) }, savedAt: new Date().toISOString() }; }
function newDraft(workspaceId: string): DecisionDraft { return { workspaceId, context: null, scope: null, ruleSet: null, eligibility: null, rankings: [], activeRankingId: null, myRank: [], portfolio: null, updatedAt: new Date().toISOString() }; }
function downloadText(text: string, filename: string) { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }

export function App() {
  const [application, setApplication] = useState<PersistedApplicationState>(emptyApplicationState());
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [storageWritable, setStorageWritable] = useState(true);
  const [storageStatus, setStorageStatus] = useState('Saved locally');
  const [activeView, setActiveView] = useState<View>('data');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const restoreInput = useRef<HTMLInputElement>(null);

  const activeWorkspace = application.workspaces.find((workspace) => workspace.id === application.activeWorkspaceId) ?? null;
  const dataset = currentDataset(activeWorkspace);
  const draft = activeWorkspace ? application.decisionDrafts.find((item) => item.workspaceId === activeWorkspace.id) ?? newDraft(activeWorkspace.id) : null;

  useEffect(() => { void loadApplicationState().then((loaded) => { setApplication(loaded); setStorageLoaded(true); setStorageStatus('Saved locally'); }).catch((error) => { setStorageLoaded(true); setStorageWritable(false); setStorageStatus('Local saving unavailable'); setNotice({ type: 'error', message: `${error instanceof Error ? error.message : 'Local state could not be restored.'} Restore a backup or delete the invalid local data to continue.` }); }); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; localStorage.setItem('erp-theme', theme); }, [theme]);
  useEffect(() => { if (!storageLoaded || !storageWritable) return; setStorageStatus('Saving…'); const timer = window.setTimeout(() => void saveApplicationState(application).then(() => setStorageStatus('Saved locally')).catch(() => { setStorageWritable(false); setStorageStatus('Save failed'); setNotice({ type: 'error', message: 'Changes could not be saved. Try again or export a backup.' }); }), 450); return () => window.clearTimeout(timer); }, [application, storageLoaded, storageWritable]);
  useEffect(() => { const beforeUnload = (event: BeforeUnloadEvent) => { if (application.workspaces.some((workspace) => workbookHasUnsavedChanges(workspace.workbook))) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload); }, [application.workspaces]);

  const replaceWorkspaceAllowed = () => !dataset?.dirty || window.confirm('This plan has unsaved changes. Replace it without exporting?');
  const updateWorkspace = (workspace: SavedWorkspace) => setApplication((current) => ({ ...current, lastCommittedAt: new Date().toISOString(), workspaces: current.workspaces.map((item) => item.id === workspace.id ? workspace : item) }));
  const updateDraft = (next: DecisionDraft) => setApplication((current) => ({ ...current, decisionDrafts: [...current.decisionDrafts.filter((item) => item.workspaceId !== next.workspaceId), next] }));
  const addWorkbook = async (workbook: WorkbookState, label: string) => { const stamped = await stampWorkbookRevisions(workbook); const id = `workspace-${crypto.randomUUID()}`; const workspace: SavedWorkspace = { id, name: label, workbook: stamped, savedAt: new Date().toISOString() }; setApplication((current) => ({ ...current, lastCommittedAt: new Date().toISOString(), workspaces: [...current.workspaces, workspace], activeWorkspaceId: id, decisionDrafts: [...current.decisionDrafts, newDraft(id)] })); setActiveView('data'); return true; };

  const loadSample = (kind: 'maintenance' | 'facilities') => { setBusy(true); const sample = kind === 'maintenance' ? createSyntheticPlanningDataset() : createSyntheticFacilitiesDataset(); const label = kind === 'maintenance' ? 'Maintenance example' : 'Facilities example'; void addWorkbook(workbookFromDataset(sample), label).then(() => setNotice({ type: 'success', message: `${label} loaded. Built-in examples are fictional and intended for demonstration.` })).catch((error) => setNotice({ type: 'error', message: error instanceof Error ? error.message : 'The example could not be loaded.' })).finally(() => setBusy(false)); };
  const importFile = async (file: File) => { setBusy(true); setNotice({ type: 'info', message: `Checking ${file.name}…` }); try { const { readPlanningWorkbook } = await import('./adapters/excel'); const workbook = await readPlanningWorkbook(new Uint8Array(await file.arrayBuffer()), file.name); await addWorkbook(workbook, file.name.replace(/\.xlsx$/i, '')); setNotice({ type: 'success', message: `${file.name} imported with ${workbook.sheets.length} worksheet${workbook.sheets.length === 1 ? '' : 's'}.` }); } catch (error) { setNotice({ type: 'error', message: error instanceof Error ? error.message : 'The workbook could not be imported.' }); } finally { setBusy(false); } };
  const handleExport = async () => { if (!activeWorkspace) return; setBusy(true); try { const { preparePlanningWorkbook, downloadBytes: downloadWorkbook, planningWorkbookFilename } = await import('./adapters/excel'); const result = await preparePlanningWorkbook(activeWorkspace.workbook); updateWorkspace({ ...activeWorkspace, workbook: result.workbook, savedAt: new Date().toISOString() }); downloadWorkbook(result.bytes, planningWorkbookFilename(result.workbook)); setNotice({ type: 'success', message: `Workbook exported with ${result.workbook.sheets.length} worksheet${result.workbook.sheets.length === 1 ? '' : 's'}.` }); } catch (error) { setNotice({ type: 'error', message: error instanceof Error ? error.message : 'The workbook could not be exported.' }); } finally { setBusy(false); } };
  const exportBackup = async () => { downloadText(await exportApplicationBackup(application), `erp-local-backup-${new Date().toISOString().slice(0,10)}.json`); setNotice({ type: 'success', message: 'Local backup exported.' }); };
  const restoreBackup = async (file: File) => { try { if (!replaceWorkspaceAllowed()) return; setApplication(await importApplicationBackup(await file.text())); setNotice({ type: 'success', message: 'Local backup restored.' }); } catch (error) { setNotice({ type: 'error', message: error instanceof Error ? error.message : 'The backup could not be restored.' }); } };
  const deleteWorkspace = () => { if (!activeWorkspace || !window.confirm(`Delete “${activeWorkspace.name}” and its local working state?`)) return; setApplication((current) => ({ ...current, workspaces: current.workspaces.filter((item) => item.id !== activeWorkspace.id), activeWorkspaceId: current.workspaces.find((item) => item.id !== activeWorkspace.id)?.id ?? null, decisionDrafts: current.decisionDrafts.filter((item) => item.workspaceId !== activeWorkspace.id) })); };
  const deleteAll = async () => { if (!window.confirm('Delete all local ERP workspaces, lists, decisions, and settings? This cannot be undone.')) return; await clearApplicationStorage(); setApplication(emptyApplicationState()); setNotice({ type: 'success', message: 'All local ERP data was deleted.' }); };
  const ensureEvidenceDataset = async (): Promise<PlanningDataset> => { if (!activeWorkspace || !dataset) throw new Error('Load planning data first.'); if (dataset.snapshotRevision && dataset.mappingRevision) return dataset; const stamped = await stampWorkbookRevisions(activeWorkspace.workbook); updateWorkspace({ ...activeWorkspace, workbook: stamped, savedAt: new Date().toISOString() }); return stamped.sheets[stamped.activeSheetIndex]; };

  if (!storageLoaded) return <main className="loading-screen"><div className="loading-mark">ERP</div><p>Opening your planning workspace…</p></main>;
  const nav: Array<{ id: View; label: string }> = [{ id: 'data', label: 'Planning Data' }, { id: 'recommendations', label: 'Recommendations' }, { id: 'portfolio', label: 'Portfolio' }, { id: 'cases', label: 'History' }, { id: 'dashboard', label: 'Overview' }];

  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="app-header"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">ERP</span><div><strong>Enterprise Resource Planner</strong><span>Planning workbench</span></div></div>
      <nav className="primary-nav" aria-label="Primary">{nav.map((item) => <button key={item.id} type="button" aria-current={activeView === item.id ? 'page' : undefined} disabled={!dataset && item.id !== 'data'} onClick={() => setActiveView(item.id)}>{item.label}</button>)}</nav>
      <div className="header-actions"><label className="plan-selector"><span className="sr-only">Current plan</span><select aria-label="Current plan" value={application.activeWorkspaceId ?? ''} onChange={(event) => { if (dataset?.dirty && !window.confirm('This plan has unsaved changes. Switch plans without exporting?')) { event.currentTarget.value = application.activeWorkspaceId ?? ''; return; } setApplication((current) => ({ ...current, activeWorkspaceId: event.target.value || null })); setActiveView('data'); }}><option value="">No plan loaded</option>{application.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
        <span className={`save-status ${storageStatus === 'Save failed' ? 'error' : storageStatus === 'Saving…' ? 'saving' : ''}`} role="status"><span aria-hidden="true" />{storageStatus}</span>
        <button className="icon-button theme-toggle" type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} aria-pressed={theme === 'light'} onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}><span aria-hidden="true">{theme === 'dark' ? '☀' : '◐'}</span></button>
        <details className="app-menu"><summary aria-label="Open data and settings menu">Menu</summary><div className="menu-popover"><strong>Data and settings</strong><button type="button" onClick={() => void exportBackup()}>Export local backup</button><button type="button" onClick={() => restoreInput.current?.click()}>Restore local backup</button><input ref={restoreInput} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => { const file=event.target.files?.[0]; if(file) void restoreBackup(file); event.currentTarget.value=''; }} /><hr /><button className="menu-danger" type="button" disabled={!activeWorkspace} onClick={deleteWorkspace}>Delete current plan</button><button className="menu-danger" type="button" onClick={() => void deleteAll()}>Delete all local data</button><details className="menu-about"><summary>About and privacy</summary><p>ERP runs locally in your browser. It does not send planning data or analytics to external services.</p></details></div></details>
      </div></header>
    <main id="main-content" className={`workspace workspace-${activeView}`}>{notice && <div className={`notice app-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.message}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
      {activeView === 'data' && <PlanningDataView workspace={activeWorkspace} dataset={dataset} busy={busy} onSample={loadSample} onImport={(file) => void importFile(file)} onExport={() => void handleExport()} onWorkspace={updateWorkspace} />}
      {activeView === 'recommendations' && activeWorkspace && dataset && draft && <RecommendationsWorkspace dataset={dataset} workbook={activeWorkspace.workbook} workspaceId={activeWorkspace.id} state={application} draft={draft} ensureEvidenceDataset={ensureEvidenceDataset} onDraft={updateDraft} onState={setApplication} />}
      {activeView === 'portfolio' && activeWorkspace && dataset && draft && <DecisionWorkspace view="portfolio" dataset={dataset} workbook={activeWorkspace.workbook} workspaceId={activeWorkspace.id} state={application} draft={draft} ensureEvidenceDataset={ensureEvidenceDataset} onDraft={updateDraft} onState={setApplication} />}
      {activeView === 'cases' && activeWorkspace && dataset && draft && <CasesWorkspace state={application} draft={draft} dataset={dataset} workbook={activeWorkspace.workbook} onState={setApplication} />}
      {activeView === 'dashboard' && dataset && draft && <DashboardWorkspace dataset={dataset} draft={draft} state={application} />}
    </main>
  </div>;
}

function PlanningDataView({ workspace, dataset, busy, onSample, onImport, onExport, onWorkspace }: { workspace: SavedWorkspace | null; dataset: PlanningDataset | null; busy: boolean; onSample: (kind: 'maintenance'|'facilities') => void; onImport: (file: File) => void; onExport: () => void; onWorkspace: (workspace: SavedWorkspace) => void }) {
  const fileInput = useRef<HTMLInputElement>(null); const updateDataset = (next: PlanningDataset) => { if (workspace) onWorkspace(withDataset(workspace, next)); };
  return <section className="module-stack" aria-labelledby="planning-data-title"><div className="page-header"><div><p className="eyebrow">Planning Data</p><h1 id="planning-data-title">{dataset ? datasetDisplayName(dataset) : 'Start a planning workbook'}</h1><p>{dataset ? 'Inspect, map, validate, edit, and export the complete workbook.' : 'Import an Excel workbook or open a fictional example.'}</p></div><div className="page-actions"><button className="button primary" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>Import Excel</button><button className="button secondary" type="button" onClick={() => onSample('facilities')}>Facilities example</button><button className="button secondary" type="button" onClick={() => onSample('maintenance')}>Maintenance example</button>{dataset && <button className="button secondary" type="button" disabled={busy} onClick={onExport}>Export workbook</button>}<input ref={fileInput} className="sr-only" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.currentTarget.value = ''; }} /></div></div>
    {!workspace || !dataset ? <div className="empty-state"><span className="empty-icon" aria-hidden="true">▦</span><h2>No planning data loaded</h2><p>Excel files stay in this browser. Built-in examples are fictional.</p></div> : <><div className="dataset-toolbar"><div className="dataset-title"><strong>{datasetDisplayName(dataset)}</strong><span>{dataset.sheetName}</span></div>{workspace.workbook.sheets.length > 1 && <label>Worksheet<select value={workspace.workbook.activeSheetIndex} onChange={(event) => onWorkspace({ ...workspace, workbook: { ...workspace.workbook, activeSheetIndex: Number(event.target.value) }, savedAt: new Date().toISOString() })}>{workspace.workbook.sheets.map((sheet, index) => <option key={sheet.id} value={index}>{sheet.sheetName}</option>)}</select></label>}<div className="dataset-facts"><span>{dataset.rows.length.toLocaleString()} rows</span><span>{dataset.columns.length} columns</span><span className={dataset.issues.some((issue) => issue.severity === 'error') ? 'fact-error' : ''}>{dataset.issues.length} issues</span><span>{dataset.dirty ? 'Unsaved changes' : 'Up to date'}</span></div></div><PlanningGrid dataset={dataset} onChange={updateDataset} /><details className="workbench-details" open={!dataset.mappingsConfirmed}><summary>Column mapping <span>{dataset.mappingsConfirmed ? 'Confirmed' : 'Needs confirmation'}</span></summary><MappingPanel dataset={dataset} onChange={updateDataset} /></details><details className="workbench-details"><summary>Data-quality issues <span>{dataset.issues.length}</span></summary><ValidationPanel dataset={dataset} /></details></>}
  </section>;
}
