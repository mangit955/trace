import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CollectorRunId,
  completeCollectorRun,
  createEvidenceNode,
  createHypothesis,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  type Investigation,
  newId,
  OrgId,
  registerCoreKinds,
  startCollectorRun,
  type TenantContext,
  transition,
} from '@trace/domain';
import { InMemoryStore } from './memory.ts';

const AT = new Date('2026-08-06T10:16:00.000Z');

const registry = new EvidenceKindRegistry();
registerCoreKinds(registry);

const acme: TenantContext = { orgId: newId(OrgId) };
const globex: TenantContext = { orgId: newId(OrgId) };

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

function investigationFor(ctx: TenantContext, id = 'INC-481'): Investigation {
  return createInvestigation({
    orgId: ctx.orgId,
    externalRef: { system: 'pagerduty', id },
    window: defaultWindowFor(AT),
    now: AT,
  });
}

function alertNode(investigation: Investigation) {
  return createEvidenceNode({
    registry,
    orgId: investigation.orgId,
    investigationId: investigation.id,
    kind: 'alert',
    kindVersion: 1,
    payload: {
      source: 'pagerduty',
      externalId: 'INC-481',
      title: 'Elevated 5xx rate on payments-api',
      severity: 'critical',
      service: 'payments-api',
      firedAt: AT.toISOString(),
    },
    connector: 'pagerduty',
    collectorRunId: newId(CollectorRunId),
    collectedAt: AT,
  });
}

describe('investigations', () => {
  test('round-trips by id', async () => {
    const investigation = investigationFor(acme);
    await store.investigations.save(acme, investigation);

    expect((await store.investigations.findById(acme, investigation.id))?.id).toBe(
      investigation.id,
    );
  });

  test('finds by the external incident it mirrors, the ingestion idempotency key', async () => {
    // A webhook delivered three times must produce one investigation, not three.
    const investigation = investigationFor(acme);
    await store.investigations.save(acme, investigation);

    const found = await store.investigations.findByExternalRef(acme, {
      system: 'pagerduty',
      id: 'INC-481',
    });

    expect(found?.id).toBe(investigation.id);
  });

  test('stores state transitions without mutating what was saved before', async () => {
    // Domain values are immutable; a repository that aliased them would let a later transition
    // silently rewrite history a caller still holds.
    const investigation = investigationFor(acme);
    await store.investigations.save(acme, investigation);
    await store.investigations.save(acme, transition(investigation, 'collecting', AT));

    expect((await store.investigations.findById(acme, investigation.id))?.status).toBe(
      'collecting',
    );
    expect(investigation.status).toBe('pending');
  });

  test('never returns another tenant’s investigation by id', async () => {
    // A misplaced orgId is a data breach, not a bug.
    const investigation = investigationFor(acme);
    await store.investigations.save(acme, investigation);

    expect(await store.investigations.findById(globex, investigation.id)).toBeUndefined();
  });

  test('never returns another tenant’s investigation by external ref', async () => {
    await store.investigations.save(acme, investigationFor(acme));

    expect(
      await store.investigations.findByExternalRef(globex, { system: 'pagerduty', id: 'INC-481' }),
    ).toBeUndefined();
  });

  test('lets two tenants mirror the same external incident independently', async () => {
    const ours = investigationFor(acme);
    const theirs = investigationFor(globex);
    await store.investigations.save(acme, ours);
    await store.investigations.save(globex, theirs);

    expect((await store.investigations.findById(acme, ours.id))?.id).toBe(ours.id);
    expect((await store.investigations.findById(globex, theirs.id))?.id).toBe(theirs.id);
  });
});

describe('evidence', () => {
  test('appends and loads a graph', async () => {
    const investigation = investigationFor(acme);
    const node = alertNode(investigation);
    await store.evidence.append(acme, investigation.id, [node], []);

    const graph = await store.evidence.loadGraph(acme, investigation.id);

    expect(graph.nodes.map((n) => n.id)).toEqual([node.id]);
  });

  test('deduplicates re-collected evidence rather than appending it twice', async () => {
    // Evidence is append-only, and re-collection is normal. Two nodes for one fact would double
    // it in the prompt and read to the model as two independent observations.
    const investigation = investigationFor(acme);
    await store.evidence.append(acme, investigation.id, [alertNode(investigation)], []);
    await store.evidence.append(acme, investigation.id, [alertNode(investigation)], []);

    expect((await store.evidence.loadGraph(acme, investigation.id)).nodes).toHaveLength(1);
  });

  test('keeps another tenant’s evidence out of the graph', async () => {
    const ours = investigationFor(acme);
    await store.evidence.append(acme, ours.id, [alertNode(ours)], []);

    expect((await store.evidence.loadGraph(globex, ours.id)).nodes).toEqual([]);
  });
});

describe('collector runs', () => {
  test('lists the runs for an investigation, which is where blind spots come from', async () => {
    const investigation = investigationFor(acme);
    const run = completeCollectorRun(
      startCollectorRun({
        orgId: acme.orgId,
        investigationId: investigation.id,
        collector: 'github',
        now: AT,
      }),
      3,
      AT,
    );
    await store.collectorRuns.save(acme, run);

    expect((await store.collectorRuns.listFor(acme, investigation.id))[0]?.collector).toBe(
      'github',
    );
  });

  test('keeps another tenant’s runs out of the list', async () => {
    const investigation = investigationFor(acme);
    await store.collectorRuns.save(
      acme,
      startCollectorRun({
        orgId: acme.orgId,
        investigationId: investigation.id,
        collector: 'github',
        now: AT,
      }),
    );

    expect(await store.collectorRuns.listFor(globex, investigation.id)).toEqual([]);
  });
});

describe('hypotheses', () => {
  test('lists what was concluded about an investigation', async () => {
    const investigation = investigationFor(acme);
    const node = alertNode(investigation);
    const hypothesis = createHypothesis({
      orgId: acme.orgId,
      investigationId: investigation.id,
      statement: 'The deploy did it.',
      confidence: 0.8,
      citations: [{ label: 'E1', stance: 'supports' }],
      idMap: new Map([['E1', node.id]]),
      model: 'gemini-2.5-flash',
      promptVersion: 'investigate/v1',
      evidenceSeen: [node.id],
      now: AT,
    });
    await store.hypotheses.save(acme, hypothesis);

    expect((await store.hypotheses.listFor(acme, investigation.id))[0]?.statement).toBe(
      'The deploy did it.',
    );
  });
});

describe('conversation links', () => {
  test('resolves a conversation to the investigation being discussed in it', async () => {
    // This is what lets a bare "why?" mean something.
    const investigation = investigationFor(acme);
    await store.conversations.link(acme, 'telegram:4821', investigation.id);

    expect(await store.conversations.resolve(acme, 'telegram:4821')).toBe(investigation.id);
  });

  test('re-links a conversation when a second investigation is discussed in it', async () => {
    const first = investigationFor(acme, 'INC-481');
    const second = investigationFor(acme, 'INC-902');
    await store.conversations.link(acme, 'telegram:4821', first.id);
    await store.conversations.link(acme, 'telegram:4821', second.id);

    expect(await store.conversations.resolve(acme, 'telegram:4821')).toBe(second.id);
  });

  test('does not leak a conversation across tenants', async () => {
    const investigation = investigationFor(acme);
    await store.conversations.link(acme, 'telegram:4821', investigation.id);

    expect(await store.conversations.resolve(globex, 'telegram:4821')).toBeUndefined();
  });
});
