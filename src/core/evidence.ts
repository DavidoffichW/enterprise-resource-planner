import type {
  CaseSnapshot,
  HumanEvent,
  HumanEventType,
  PersistedApplicationState,
  PlanningCase,
  PriorityListRevision,
  ScenarioRecord,
} from '../contracts';
import { canonicalDigest, canonicalSerialize } from './revision';
import { optimizePortfolio } from './portfolio';
import { createPriorityListRevision } from './ranking';

const CASE_ENVELOPE_VERSION = '2.0';
const BACKUP_ENVELOPE_VERSION = '2.0';

export interface PortableCaseEnvelope {
  product: 'Enterprise Resource Planner';
  envelopeVersion: typeof CASE_ENVELOPE_VERSION;
  contentType: 'ERP_CASE';
  planningCase: PlanningCase;
  digest: string;
}

export interface ApplicationBackupEnvelope {
  product: 'Enterprise Resource Planner';
  envelopeVersion: typeof BACKUP_ENVELOPE_VERSION;
  contentType: 'ERP_APPLICATION_BACKUP';
  state: PersistedApplicationState;
  digest: string;
}

function caseBody(planningCase: Omit<PlanningCase, 'revision' | 'checksum'> | PlanningCase) {
  const { revision: _revision, checksum: _checksum, ...body } = planningCase as PlanningCase;
  return body;
}

export async function createPlanningCase(
  name: string,
  snapshot: CaseSnapshot,
  parentCaseId: string | null = null,
  parentScenarioId: string | null = null,
  now = new Date().toISOString(),
): Promise<PlanningCase> {
  if (snapshot.dataset.snapshotRevision !== snapshot.context.datasetSnapshotRevision ||
      snapshot.scope.datasetSnapshotRevision !== snapshot.context.datasetSnapshotRevision ||
      (snapshot.eligibility && snapshot.eligibility.datasetSnapshotRevision !== snapshot.context.datasetSnapshotRevision) ||
      snapshot.rankings.some((ranking) => ranking.datasetSnapshotRevision !== snapshot.context.datasetSnapshotRevision)) {
    throw new Error('Case evidence does not share one immutable dataset snapshot.');
  }
  const base = {
    schemaVersion: '2.0' as const,
    id: '',
    name,
    createdAt: now,
    snapshot,
    events: [] as HumanEvent[],
    parentCaseId,
    parentScenarioId,
  };
  const identityDigest = await canonicalDigest({ schema: 'erp-case-identity/1', ...base, id: undefined });
  const withId = { ...base, id: `case-${identityDigest.slice(7, 23)}` };
  const checksum = await canonicalDigest({ schema: 'erp-case-revision/1', ...withId });
  return { ...withId, revision: checksum, checksum };
}

export async function appendHumanEvent(
  planningCase: PlanningCase,
  input: {
    type: HumanEventType;
    actorLabel: string;
    rowId?: string | null;
    value: string;
    reason: string;
    supersedesEventId?: string | null;
    occurredAt?: string;
  },
): Promise<PlanningCase> {
  if (!input.actorLabel.trim() || !input.value.trim() || !input.reason.trim()) {
    throw new Error('Committed human evidence requires actor, value, and reason.');
  }
  if (input.type === 'EVIDENCE_CORRECTED' && !input.supersedesEventId) {
    throw new Error('An evidence correction must identify the superseded event.');
  }
  if (input.type !== 'EVIDENCE_CORRECTED' && input.supersedesEventId) {
    throw new Error('Only an evidence correction may supersede an earlier event.');
  }
  if (input.supersedesEventId && !planningCase.events.some((event) => event.id === input.supersedesEventId)) {
    throw new Error('A correction must reference an existing event.');
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventDraft = {
    type: input.type,
    occurredAt,
    actorLabel: input.actorLabel.trim(),
    rowId: input.rowId ?? null,
    value: input.value,
    reason: input.reason,
    supersedesEventId: input.supersedesEventId ?? null,
  };
  const eventDigest = await canonicalDigest({ schema: 'erp-human-event/1', caseId: planningCase.id, sequence: planningCase.events.length, ...eventDraft });
  const event: HumanEvent = { id: `event-${eventDigest.slice(7, 23)}`, ...eventDraft };
  const body = { ...caseBody(planningCase), events: [...planningCase.events, event] };
  const checksum = await canonicalDigest({ schema: 'erp-case-revision/1', ...body });
  return { ...body, revision: checksum, checksum };
}

export async function createScenario(
  parentCase: PlanningCase,
  name: string,
  overrides: ScenarioRecord['overrides'],
  now = new Date().toISOString(),
): Promise<ScenarioRecord> {
  if (!parentCase.id || !name.trim()) throw new Error('Scenario requires a parent Case and name.');
  const identityDigest = await canonicalDigest({ schema: 'erp-scenario-identity/2', parentCaseId: parentCase.id, parentCaseRevision: parentCase.revision, name: name.trim(), overrides });
  const body = { schemaVersion: '2.0' as const, id: `scenario-${identityDigest.slice(7, 23)}`, parentCaseId: parentCase.id, parentCaseRevision: parentCase.revision, name: name.trim(), createdAt: now, overrides, status: 'UNEVALUATED' as const, resultCaseId: null, resultSummary: 'Scenario inputs recorded but not evaluated.' };
  const checksum = await canonicalDigest({ schema: 'erp-scenario/2', ...body });
  return { ...body, checksum };
}

export async function evaluateScenario(
  parentCase: PlanningCase,
  name: string,
  overrides: ScenarioRecord['overrides'],
  now = new Date().toISOString(),
): Promise<{ scenario: ScenarioRecord; planningCase: PlanningCase }> {
  if (!await verifyPlanningCase(parentCase)) throw new Error('Scenario parent Case failed integrity verification.');
  const portfolio = parentCase.snapshot.portfolio;
  if (!portfolio || portfolio.schemaVersion !== '2.0' || !Array.isArray(portfolio.candidates) || !portfolio.constraint) {
    throw new Error('This Case does not contain replayable portfolio inputs. Create a new qualified Case before evaluating a scenario.');
  }
  const baseScenario = await createScenario(parentCase, name, overrides, now);
  const available = new Map(portfolio.candidates.map((candidate) => [candidate.rowId, candidate]));
  const requestedIds = overrides.candidateRowIds ?? parentCase.snapshot.scope.candidateRowIds;
  if (!requestedIds.length || new Set(requestedIds).size !== requestedIds.length || requestedIds.some((rowId) => !available.has(rowId))) {
    throw new Error('Scenario Candidate Scope must be a non-empty subset of the immutable parent portfolio population.');
  }
  const ranking = overrides.rankingResultId
    ? parentCase.snapshot.rankings.find((item) => item.id === overrides.rankingResultId)
    : parentCase.snapshot.rankings.find((item) => item.id === portfolio.objectiveRankingResultId) ?? null;
  if (overrides.rankingResultId && !ranking) throw new Error('The selected scenario ranking is not present in the immutable parent Case.');
  const scenarioRanks = ranking
    ? requestedIds
        .map((rowId) => ({ rowId, rank: ranking.ranks.find((item) => item.rowId === rowId)?.rank ?? null }))
        .sort((left, right) => {
          if (left.rank === null && right.rank === null) return left.rowId.localeCompare(right.rowId);
          if (left.rank === null) return 1;
          if (right.rank === null) return -1;
          return left.rank - right.rank || left.rowId.localeCompare(right.rowId);
        })
        .filter((item) => item.rank !== null)
    : [];
  const scenarioRankValues = new Map(scenarioRanks.map((item, index) => [item.rowId, scenarioRanks.length - index]));
  const candidates = requestedIds.flatMap((rowId) => {
    const base = available.get(rowId)!;
    if (!ranking) return [structuredClone(base)];
    const scenarioValue = scenarioRankValues.get(rowId);
    return scenarioValue === undefined ? [] : [{ ...structuredClone(base), value: scenarioValue }];
  });
  if (!candidates.length) throw new Error('The scenario ranking has no ranked candidates in the selected scope.');
  const constraint = { ...structuredClone(portfolio.constraint), budget: overrides.budget ?? portfolio.constraint.budget };
  const scenarioPortfolio = await optimizePortfolio(parentCase.snapshot.context.id, parentCase.snapshot.context.datasetSnapshotRevision, candidates, constraint, now, ranking?.id ?? portfolio.objectiveRankingResultId);
  const scopeBody = {
    ...parentCase.snapshot.scope,
    id: '', revision: '', checksum: '', createdAt: now,
    mode: 'MANUAL' as const,
    candidateRowIds: [...requestedIds],
    manualIncludedRowIds: [...requestedIds],
    manualExcludedRowIds: parentCase.snapshot.scope.candidateRowIds.filter((rowId) => !requestedIds.includes(rowId)),
    rationale: `Scenario override derived from immutable parent Case ${parentCase.id}.`,
  };
  const scopeChecksum = await canonicalDigest({ schema: 'erp-candidate-scope/1', ...scopeBody, id: undefined, revision: undefined, checksum: undefined, createdAt: undefined });
  const scenarioScope = { ...scopeBody, id: `scope-${scopeChecksum.slice(7, 23)}`, revision: scopeChecksum, checksum: scopeChecksum };
  const planningCase = await createPlanningCase(
    `${parentCase.name} — ${name.trim()}`,
    { ...structuredClone(parentCase.snapshot), scope: scenarioScope, eligibility: null, portfolio: scenarioPortfolio },
    parentCase.id,
    baseScenario.id,
    now,
  );
  const evaluatedBody = {
    ...baseScenario,
    status: 'EVALUATED' as const,
    resultCaseId: planningCase.id,
    resultSummary: `${scenarioPortfolio.selectedRowIds.length} items selected at budget ${constraint.budget}. No human decision was recorded.`,
  };
  const checksum = await canonicalDigest({ schema: 'erp-scenario/2', ...evaluatedBody, checksum: undefined });
  return { scenario: { ...evaluatedBody, checksum }, planningCase };
}

export async function recordReplacementDecision(
  existingCases: PlanningCase[],
  input: { name: string; snapshot: CaseSnapshot; selectedRowId: string; rankingResultId: string | null; actorLabel: string; reason: string; now?: string },
): Promise<{ planningCase: PlanningCase; created: boolean; decisionId: string }> {
  const { dataset, context, scope, ruleSet, eligibility } = input.snapshot;
  if (!dataset.rows.some((row) => row.id === input.selectedRowId)) throw new Error('The selected replacement is not present in the immutable dataset snapshot.');
  if (context.objective !== 'JOB_REPLACEMENT' || context.targetRowIds.length !== 1) throw new Error('A replacement decision requires exactly one planned job.');
  if (context.targetRowIds.includes(input.selectedRowId)) throw new Error('The planned job cannot also be its replacement.');
  if (
    context.datasetId !== dataset.id ||
    context.datasetSnapshotRevision !== dataset.snapshotRevision ||
    context.mappingRevision !== dataset.mappingRevision
  ) throw new Error('The decision context does not match the immutable planning dataset.');
  if (
    scope.datasetId !== dataset.id ||
    scope.datasetSnapshotRevision !== context.datasetSnapshotRevision ||
    scope.decisionContextId !== context.id
  ) throw new Error('Candidate Scope does not match the decision context and planning dataset.');
  if (!scope.candidateRowIds.includes(input.selectedRowId)) throw new Error('The selected replacement is outside the recorded Candidate Scope.');
  if (eligibility && (
    !ruleSet ||
    eligibility.decisionContextId !== context.id ||
    eligibility.datasetSnapshotRevision !== context.datasetSnapshotRevision ||
    eligibility.scopeRevision !== scope.revision ||
    eligibility.ruleSetRevision !== ruleSet.revision
  )) throw new Error('The recorded assessment evidence does not match this decision context.');
  const ranking = input.rankingResultId ? input.snapshot.rankings.find((item) => item.id === input.rankingResultId) ?? null : null;
  if (input.rankingResultId && !ranking) throw new Error('The selected recommendation source is not present in the Case snapshot.');
  if (ranking && (
    ranking.contextId !== input.snapshot.context.id ||
    ranking.scopeRevision !== input.snapshot.scope.revision ||
    ranking.datasetSnapshotRevision !== context.datasetSnapshotRevision ||
    ranking.eligibilityRunId !== (eligibility?.id ?? null) ||
    !ranking.candidateRowIds.includes(input.selectedRowId) ||
    ranking.candidateRowIds.length !== scope.candidateRowIds.length ||
    ranking.candidateRowIds.some((rowId, index) => rowId !== scope.candidateRowIds[index])
  )) {
    throw new Error('The selected recommendation was calculated for different planning data, checks, or candidates. Rank this decision again before saving it.');
  }
  const decisionId = await canonicalDigest({
    schema: 'erp-replacement-decision/3',
    contextId: context.id,
    datasetSnapshotRevision: context.datasetSnapshotRevision,
    mappingRevision: context.mappingRevision,
    scopeRevision: scope.revision,
    effectiveDate: context.effectiveDate,
    targetRowIds: context.targetRowIds,
    selectedRowId: input.selectedRowId,
    assessmentEvidence: eligibility ? { id: eligibility.id, ruleSetRevision: eligibility.ruleSetRevision } : null,
    rankingSource: ranking ? { resultId: ranking.id, id: ranking.source.id, revision: ranking.source.revision } : null,
  });
  const existing = existingCases.find((planningCase) => {
    if (
      planningCase.snapshot.context.id !== input.snapshot.context.id ||
      planningCase.snapshot.scope.revision !== input.snapshot.scope.revision
    ) return false;
    return planningCase.events.some((event) => {
      if (event.type !== 'DECISION_RECORDED') return false;
      try {
        const value = JSON.parse(event.value) as { decisionId?: unknown; selectedRowId?: unknown; rankingSource?: { resultId?: unknown } | null };
        if (typeof value.decisionId === 'string') return value.decisionId === decisionId;
        return (
          value.selectedRowId === input.selectedRowId &&
          (value.rankingSource?.resultId ?? null) === (ranking?.id ?? null)
        );
      } catch { return false; }
    });
  });
  if (existing) return { planningCase: existing, created: false, decisionId };
  let planningCase = await createPlanningCase(input.name, input.snapshot, null, null, input.now);
  planningCase = await appendHumanEvent(planningCase, {
    type: 'DECISION_RECORDED',
    actorLabel: input.actorLabel,
    rowId: input.selectedRowId,
    value: JSON.stringify({
      schemaVersion: '1.0', decisionId, selectedRowId: input.selectedRowId,
      plannedRowIds: context.targetRowIds,
      assessmentEvidence: eligibility ? { id: eligibility.id, ruleSetRevision: eligibility.ruleSetRevision } : null,
      rankingSource: ranking ? { resultId: ranking.id, type: ranking.source.type, id: ranking.source.id, revision: ranking.source.revision, label: ranking.source.label } : null,
    }),
    reason: input.reason,
    occurredAt: input.now,
  });
  return { planningCase, created: true, decisionId };
}

export async function verifyPlanningCase(planningCase: PlanningCase): Promise<boolean> {
  if (!['1.0', '2.0'].includes(planningCase.schemaVersion) || !/^sha256:[0-9a-f]{64}$/.test(planningCase.checksum) || planningCase.revision !== planningCase.checksum) return false;
  return await canonicalDigest({ schema: 'erp-case-revision/1', ...caseBody(planningCase) }) === planningCase.checksum;
}

export async function exportPortableCase(planningCase: PlanningCase): Promise<string> {
  if (!await verifyPlanningCase(planningCase)) throw new Error('Case integrity validation failed before export.');
  const body = {
    product: 'Enterprise Resource Planner' as const,
    envelopeVersion: CASE_ENVELOPE_VERSION,
    contentType: 'ERP_CASE' as const,
    planningCase,
  };
  return canonicalSerialize({ ...body, digest: await canonicalDigest(body) });
}

export async function importPortableCase(serialized: string): Promise<PlanningCase> {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error('Portable Case is not valid JSON.'); }
  if (!value || typeof value !== 'object') throw new Error('Portable Case envelope is invalid.');
  const envelope = value as Partial<PortableCaseEnvelope>;
  if (envelope.product !== 'Enterprise Resource Planner' || !['1.0', CASE_ENVELOPE_VERSION].includes(String(envelope.envelopeVersion)) ||
      envelope.contentType !== 'ERP_CASE' || !envelope.planningCase || typeof envelope.digest !== 'string') {
    throw new Error('Portable Case version or content type is unsupported.');
  }
  const body = { product: envelope.product, envelopeVersion: envelope.envelopeVersion, contentType: envelope.contentType, planningCase: envelope.planningCase };
  if (!validPlanningCaseShape(envelope.planningCase) || await canonicalDigest(body) !== envelope.digest || !await verifyPlanningCase(envelope.planningCase)) {
    throw new Error('Portable Case integrity validation failed.');
  }
  return envelope.planningCase;
}

export function emptyApplicationState(): PersistedApplicationState {
  return { schemaVersion: '2.0', workspaces: [], activeWorkspaceId: null, priorityLists: [], cases: [], scenarios: [], savedViews: [], decisionDrafts: [], relationships: [], historicalEvents: [], lastCommittedAt: null };
}

export async function exportApplicationBackup(state: PersistedApplicationState): Promise<string> {
  const body = {
    product: 'Enterprise Resource Planner' as const,
    envelopeVersion: BACKUP_ENVELOPE_VERSION,
    contentType: 'ERP_APPLICATION_BACKUP' as const,
    state,
  };
  return canonicalSerialize({ ...body, digest: await canonicalDigest(body) });
}

export async function importApplicationBackup(serialized: string): Promise<PersistedApplicationState> {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error('Application backup is not valid JSON.'); }
  if (!value || typeof value !== 'object') throw new Error('Application backup envelope is invalid.');
  const envelope = value as Partial<ApplicationBackupEnvelope>;
  if (envelope.product !== 'Enterprise Resource Planner' || !['1.0', BACKUP_ENVELOPE_VERSION].includes(String(envelope.envelopeVersion)) ||
      envelope.contentType !== 'ERP_APPLICATION_BACKUP' || !envelope.state || !['1.0', '2.0'].includes(String((envelope.state as {schemaVersion?: unknown}).schemaVersion)) || typeof envelope.digest !== 'string') {
    throw new Error('Application backup version or content type is unsupported.');
  }
  const body = { product: envelope.product, envelopeVersion: envelope.envelopeVersion, contentType: envelope.contentType, state: envelope.state };
  if (await canonicalDigest(body) !== envelope.digest) throw new Error('Application backup integrity validation failed.');
  const migrated = await migrateApplicationState(envelope.state);
  if (!await validateApplicationState(migrated)) {
    throw new Error('Application backup contains invalid or inconsistent application records.');
  }
  return migrated;
}

export async function migrateApplicationState(value: unknown): Promise<PersistedApplicationState> {
  if (!value || typeof value !== 'object') throw new Error('ERP application state is not an object.');
  const legacy = value as Record<string, unknown>;
  if (!['1.0', '2.0'].includes(String(legacy.schemaVersion))) throw new Error(`ERP application-state schema “${String(legacy.schemaVersion)}” is unsupported.`);
  const base = { ...emptyApplicationState(), ...legacy } as unknown as PersistedApplicationState;
  if (!Array.isArray(base.workspaces) || !Array.isArray(base.priorityLists) || !Array.isArray(base.cases) || !Array.isArray(base.scenarios) || !Array.isArray(base.decisionDrafts)) {
    throw new Error('ERP application state is missing required collections.');
  }
  const priorityLists: PriorityListRevision[] = [];
  for (const candidate of base.priorityLists as unknown[]) {
    const list = candidate as Partial<PriorityListRevision> & { schemaVersion?: string };
    if (list.schemaVersion === '2.0' && Array.isArray(list.entries) && Array.isArray(list.issues)) { priorityLists.push(list as PriorityListRevision); continue; }
    if (!list || !Array.isArray(list.entries) || typeof list.name !== 'string' || typeof list.identifierHeader !== 'string' || typeof list.rankHeader !== 'string' || typeof list.sourceName !== 'string') {
      throw new Error('Legacy Priority List is structurally invalid.');
    }
    priorityLists.push(await createPriorityListRevision(list.name, list.identifierHeader, list.rankHeader, list.entries as PriorityListRevision['entries'], list.sourceName, list.createdAt, undefined));
  }
  const cases = base.cases;
  const scenarios: ScenarioRecord[] = [];
  for (const candidate of base.scenarios as unknown[]) {
    const scenario = candidate as Partial<ScenarioRecord> & { schemaVersion?: string; overrides?: Record<string, unknown> };
    if (scenario.schemaVersion === '2.0' && typeof scenario.checksum === 'string') { scenarios.push(scenario as ScenarioRecord); continue; }
    const parent = cases.find((item) => item.id === scenario.parentCaseId);
    if (!parent || typeof scenario.name !== 'string') continue;
    const migrated = await createScenario(parent, scenario.name, {
      budget: typeof scenario.overrides?.budget === 'number' ? scenario.overrides.budget : undefined,
      notes: typeof scenario.overrides?.notes === 'string' ? scenario.overrides.notes : 'Migrated legacy scenario; prior branch was not treated as evaluated evidence.',
    }, typeof scenario.createdAt === 'string' ? scenario.createdAt : new Date().toISOString());
    scenarios.push(migrated);
  }
  return {
    ...base,
    schemaVersion: '2.0',
    priorityLists,
    scenarios,
    decisionDrafts: base.decisionDrafts.map((draft) => ({ ...draft, activeRankingId: draft.activeRankingId ?? null })),
    relationships: Array.isArray(base.relationships) ? base.relationships : [],
    historicalEvents: Array.isArray(base.historicalEvents) ? base.historicalEvents : [],
    savedViews: Array.isArray(base.savedViews) ? base.savedViews : [],
  };
}

export async function validateApplicationState(value: PersistedApplicationState): Promise<boolean> {
  try {
    return validApplicationState(value) && (await Promise.all(value.cases.map(verifyPlanningCase))).every(Boolean);
  } catch {
    return false;
  }
}

function validPlanningCaseShape(value: PlanningCase): boolean {
  return ['1.0', '2.0'].includes(value.schemaVersion) && typeof value.id === 'string' && typeof value.name === 'string' &&
    typeof value.revision === 'string' && Array.isArray(value.events) && value.events.every((event) =>
      typeof event.id === 'string' && typeof event.type === 'string' && typeof event.actorLabel === 'string' &&
      typeof event.value === 'string' && typeof event.reason === 'string') &&
    !!value.snapshot && !!value.snapshot.dataset && !!value.snapshot.context && !!value.snapshot.scope &&
    Array.isArray(value.snapshot.rankings) && Array.isArray(value.snapshot.myRank);
}

function validApplicationState(value: PersistedApplicationState): boolean {
  if (value.schemaVersion !== '2.0' || !Array.isArray(value.workspaces) || !Array.isArray(value.priorityLists) ||
      !Array.isArray(value.cases) || !Array.isArray(value.scenarios) || !Array.isArray(value.savedViews) || !Array.isArray(value.decisionDrafts) ||
      !Array.isArray(value.relationships) || !Array.isArray(value.historicalEvents)) return false;
  if (value.activeWorkspaceId !== null && !value.workspaces.some((workspace) => workspace.id === value.activeWorkspaceId)) return false;
  const workspaceIds = new Set<string>();
  for (const workspace of value.workspaces) {
    if (!workspace || typeof workspace.id !== 'string' || workspaceIds.has(workspace.id) || typeof workspace.name !== 'string' ||
        !workspace.workbook || !Array.isArray(workspace.workbook.sheets) || !Number.isSafeInteger(workspace.workbook.activeSheetIndex) ||
        workspace.workbook.activeSheetIndex < 0 || workspace.workbook.activeSheetIndex >= workspace.workbook.sheets.length) return false;
    workspaceIds.add(workspace.id);
  }
  return value.priorityLists.every((list) => !!list && list.schemaVersion === '2.0' && typeof list.id === 'string' && typeof list.revision === 'string' && Array.isArray(list.entries)) &&
    value.scenarios.every((scenario) => !!scenario && scenario.schemaVersion === '2.0' && typeof scenario.id === 'string' && typeof scenario.parentCaseId === 'string') &&
    value.decisionDrafts.every((draft) => !!draft && typeof draft.workspaceId === 'string' && workspaceIds.has(draft.workspaceId)) &&
    value.relationships.every((record) => !!record && typeof record.relationshipId === 'string' && typeof record.fromEntityId === 'string' && typeof record.toEntityId === 'string') &&
    value.historicalEvents.every((event) => !!event && typeof event.eventId === 'string' && typeof event.entityId === 'string' && typeof event.occurredAt === 'string');
}
