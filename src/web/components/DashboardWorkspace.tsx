import type { DecisionDraft, PersistedApplicationState, PlanningDataset } from '../../contracts';
import { buildDashboard } from '../../core';

export function DashboardWorkspace({ dataset, draft, state }: { dataset: PlanningDataset; draft: DecisionDraft; state: PersistedApplicationState }) {
  const summary = buildDashboard(dataset, draft.eligibility?.evaluations, draft.portfolio, state.cases, state.relationships.length, state.historicalEvents.length);
  return <section className="module-stack" aria-labelledby="dashboard-title">
    <div className="module-hero"><p className="eyebrow">Dashboard</p><h1 id="dashboard-title">Evidence-derived planning summary.</h1><p>Every measure below identifies its source and meaning. Missing evidence remains empty; no benefit or outcome is invented.</p></div>
    <section className="metric-grid" aria-label="Planning metrics">{summary.metrics.map((metric)=><article className="metric-card" key={metric.id}><span>{metric.label}</span><strong>{metric.value.toLocaleString()}</strong><details><summary>Source and meaning</summary><p>{metric.source}</p><p>{metric.meaning}</p></details></article>)}</section>
    <div className="dashboard-grid"><Distribution title="Status distribution" values={summary.statusDistribution}/><Distribution title="Priority distribution" values={summary.priorityDistribution}/><Distribution title="Eligibility states" values={summary.eligibilityDistribution}/></div>
    <section className="panel"><h2>Portfolio drill-down</h2>{summary.portfolioSelected.length?<ul>{summary.portfolioSelected.map((id)=><li key={id}>{id}</li>)}</ul>:<p className="empty-copy">No portfolio result is available for the active decision context.</p>}</section>
  </section>;
}
function Distribution({ title, values }: { title: string; values: Array<{ label: string; count: number }> }) {
  const maximum = Math.max(1, ...values.map((value)=>value.count));
  return <section className="panel distribution"><h2>{title}</h2>{values.length?values.map((value)=><div className="bar-row" key={value.label}><span>{value.label}</span><div className="bar-track" aria-hidden="true"><span style={{width:`${value.count/maximum*100}%`}}/></div><b>{value.count}</b></div>):<p className="empty-copy">No governed evidence is available.</p>}</section>;
}
