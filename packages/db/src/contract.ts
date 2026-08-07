import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CollectorRunId,
  completeCollectorRun,
  createEvidenceEdge,
  createEvidenceNode,
  createHypothesis,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  type EvidenceNode,
  type Investigation,
  newId,
  OrgId,
  registerCoreKinds,
  startCollectorRun,
  type TenantContext,
  transition,
} from '@trace/domain';
import { EMBEDDING_DIMENSIONS, type InvestigationReport } from '@trace/reasoner';
import type { TraceStore } from './store.ts';

/**
 * The repository contract, run against every implementation.
 *
 * These tests describe what the *domain* requires of storage, so they belong to neither
 * implementation. Written once and executed twice, they are the only thing that makes "in-memory
 * for the demo, Postgres in production" a safe claim rather than a hope: a behaviour the in-memory
 * store has and Postgres does not is a defect that only shows up in production, at 3am, in the one
 * mode nobody develops against.
 *
 * Tenancy is asserted per repository rather than once, because a misplaced `orgId` is a data breach
 * and every method is a separate chance to forget the filter.
 */

const AT = new Date('2026-08-06T10:16:00.000Z');

/** A unit vector along one axis, at the width the schema pins. */
function axis(index: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

/** A vector between the first two axes, for "close but not identical". */
function blend(first: number, second: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = first;
  vector[1] = second;
  return vector;
}

const registry = new EvidenceKindRegistry();
registerCoreKinds(registry);

export interface StoreUnderTest {
  /** A fresh store, or the same one — tenants are minted per test, so isolation does not need it. */
  makeStore(): Promise<TraceStore> | TraceStore;
  /**
   * Registers a tenant before the test uses it.
   *
   * Postgres needs the `orgs` row that every foreign key points at; the in-memory store has no such
   * concept and omits this. Deliberately a hook rather than an implicit insert inside `save()` —
   * an org appearing because an investigation referenced it would make a typo'd `orgId` create a
   * tenant instead of failing, which is the breach this design exists to prevent.
   */
  ensureTenant?(ctx: TenantContext): Promise<void>;
  /** Torn down once, for a store holding a connection pool. */
  close?(): Promise<void>;
}

export function describeStoreContract(name: string, subject: StoreUnderTest): void {
  describe(name, () => {
    let store: TraceStore;

    // Fresh tenants per test rather than a truncated database: it exercises the org filter on every
    // single assertion, and it means a Postgres run leaves no state that could make the next run
    // pass for the wrong reason.
    let acme: TenantContext;
    let globex: TenantContext;

    beforeEach(async () => {
      store = await subject.makeStore();
      acme = { orgId: newId(OrgId) };
      globex = { orgId: newId(OrgId) };
      await subject.ensureTenant?.(acme);
      await subject.ensureTenant?.(globex);
    });

    afterAll(async () => {
      await subject.close?.();
    });

    /** Persisted first, because every other table references it. */
    async function saved(ctx: TenantContext, id = 'INC-481'): Promise<Investigation> {
      const investigation = createInvestigation({
        orgId: ctx.orgId,
        externalRef: { system: 'pagerduty', id },
        window: defaultWindowFor(AT),
        now: AT,
      });
      await store.investigations.save(ctx, investigation);
      return investigation;
    }

    function alertNode(investigation: Investigation, at = AT): EvidenceNode {
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
          firedAt: at.toISOString(),
        },
        connector: 'pagerduty',
        collectorRunId: newId(CollectorRunId),
        collectedAt: AT,
      });
    }

    function deployNode(investigation: Investigation, at: Date): EvidenceNode {
      return createEvidenceNode({
        registry,
        orgId: investigation.orgId,
        investigationId: investigation.id,
        kind: 'deployment',
        kindVersion: 1,
        payload: {
          service: 'payments-api',
          environment: 'production',
          version: 'v2.14.0',
          deployedBy: 'priya',
          status: 'succeeded',
          deployedAt: at.toISOString(),
          url: 'https://github.com/acme/payments-api/deployments/9001',
        },
        connector: 'github',
        collectorRunId: newId(CollectorRunId),
        collectedAt: AT,
      });
    }

    describe('investigations', () => {
      test('round-trips by id', async () => {
        const investigation = await saved(acme);

        expect((await store.investigations.findById(acme, investigation.id))?.id).toBe(
          investigation.id,
        );
      });

      test('round-trips every field, not merely the id', async () => {
        // A column silently dropped on write reads as a subtly different investigation later.
        const investigation = await saved(acme);
        const found = await store.investigations.findById(acme, investigation.id);

        expect(found).toEqual(investigation);
      });

      test('finds by the external incident it mirrors, the ingestion idempotency key', async () => {
        // A webhook delivered three times must produce one investigation, not three.
        const investigation = await saved(acme);

        const found = await store.investigations.findByExternalRef(acme, {
          system: 'pagerduty',
          id: 'INC-481',
        });

        expect(found?.id).toBe(investigation.id);
      });

      test('stores state transitions without mutating what was saved before', async () => {
        // Domain values are immutable; a repository that aliased them would let a later transition
        // silently rewrite history a caller still holds.
        const investigation = await saved(acme);
        await store.investigations.save(acme, transition(investigation, 'collecting', AT));

        expect((await store.investigations.findById(acme, investigation.id))?.status).toBe(
          'collecting',
        );
        expect(investigation.status).toBe('pending');
      });

      test('records a failure reason, so a failed investigation is actionable', async () => {
        const investigation = await saved(acme);
        const failed = {
          ...transition(investigation, 'failed', AT),
          failureReason: 'every collector timed out',
        };
        await store.investigations.save(acme, failed);

        expect((await store.investigations.findById(acme, investigation.id))?.failureReason).toBe(
          'every collector timed out',
        );
      });

      test('never returns another tenant’s investigation by id', async () => {
        // A misplaced orgId is a data breach, not a bug.
        const investigation = await saved(acme);

        expect(await store.investigations.findById(globex, investigation.id)).toBeUndefined();
      });

      test('never returns another tenant’s investigation by external ref', async () => {
        await saved(acme);

        expect(
          await store.investigations.findByExternalRef(globex, {
            system: 'pagerduty',
            id: 'INC-481',
          }),
        ).toBeUndefined();
      });

      test('lets two tenants mirror the same external incident independently', async () => {
        const ours = await saved(acme);
        const theirs = await saved(globex);

        expect((await store.investigations.findById(acme, ours.id))?.id).toBe(ours.id);
        expect((await store.investigations.findById(globex, theirs.id))?.id).toBe(theirs.id);
        expect(ours.id).not.toBe(theirs.id);
      });
    });

    describe('evidence', () => {
      test('appends and loads a graph', async () => {
        const investigation = await saved(acme);
        const node = alertNode(investigation);
        await store.evidence.append(acme, investigation.id, [node], []);

        const graph = await store.evidence.loadGraph(acme, investigation.id);

        expect(graph.nodes.map((n) => n.id)).toEqual([node.id]);
      });

      test('round-trips a node whole, including payload and all three clocks', async () => {
        // The payload is what the reasoner is shown and what a citation resolves to. A date that
        // came back as a string, or a dropped `sourceUrl`, breaks rendering rather than storage —
        // a long way from here.
        const investigation = await saved(acme);
        const node = deployNode(investigation, new Date('2026-08-06T09:58:00.000Z'));
        await store.evidence.append(acme, investigation.id, [node], []);

        const [loaded] = (await store.evidence.loadGraph(acme, investigation.id)).nodes;

        expect(loaded).toEqual(node);
        expect(loaded?.occurredAt).toBeInstanceOf(Date);
      });

      test('deduplicates re-collected evidence rather than appending it twice', async () => {
        // Evidence is append-only, and re-collection is normal. Two nodes for one fact would double
        // it in the prompt and read to the model as two independent observations.
        const investigation = await saved(acme);
        await store.evidence.append(acme, investigation.id, [alertNode(investigation)], []);
        await store.evidence.append(acme, investigation.id, [alertNode(investigation)], []);

        expect((await store.evidence.loadGraph(acme, investigation.id)).nodes).toHaveLength(1);
      });

      test('deduplicates edges too, not only nodes', async () => {
        // Phase 2 shipped green with node dedupe and no edge dedupe, so one fact reported by two
        // collectors printed twice and read to the model as two independent observations.
        const investigation = await saved(acme);
        const alert = alertNode(investigation);
        const deploy = deployNode(investigation, new Date('2026-08-06T09:58:00.000Z'));
        const edge = createEvidenceEdge({
          orgId: acme.orgId,
          investigationId: investigation.id,
          from: deploy.id,
          to: alert.id,
          relation: 'PRECEDED',
        });

        await store.evidence.append(acme, investigation.id, [alert, deploy], [edge]);
        await store.evidence.append(acme, investigation.id, [alert, deploy], [edge]);

        expect((await store.evidence.loadGraph(acme, investigation.id)).edges).toHaveLength(1);
      });

      test('orders a reloaded graph by occurredAt, not by insertion order', async () => {
        // Ordering is the one thing an incident timeline must get right, and collection order is
        // nothing like event order.
        const investigation = await saved(acme);
        const alert = alertNode(investigation);
        const deploy = deployNode(investigation, new Date('2026-08-06T09:58:00.000Z'));

        // Deliberately inserted alert-first, which is the wrong order.
        await store.evidence.append(acme, investigation.id, [alert, deploy], []);

        expect(
          (await store.evidence.loadGraph(acme, investigation.id)).nodes.map((n) => n.id),
        ).toEqual([deploy.id, alert.id]);
      });

      test('keeps another tenant’s evidence out of the graph', async () => {
        const ours = await saved(acme);
        await store.evidence.append(acme, ours.id, [alertNode(ours)], []);

        expect((await store.evidence.loadGraph(globex, ours.id)).nodes).toEqual([]);
      });
    });

    describe('collector runs', () => {
      test('lists the runs for an investigation, which is where blind spots come from', async () => {
        const investigation = await saved(acme);
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

      test('upserts a run rather than duplicating it, since it is saved twice', async () => {
        // A run is written when it starts and again when it finishes. Two rows would report one
        // collector as both running and succeeded — and "did not finish in time" is a stated gap.
        const investigation = await saved(acme);
        const started = startCollectorRun({
          orgId: acme.orgId,
          investigationId: investigation.id,
          collector: 'github',
          now: AT,
        });
        await store.collectorRuns.save(acme, started);
        await store.collectorRuns.save(acme, completeCollectorRun(started, 3, AT));

        const runs = await store.collectorRuns.listFor(acme, investigation.id);

        expect(runs).toHaveLength(1);
        expect(runs[0]?.status).toBe('succeeded');
        expect(runs[0]?.nodeCount).toBe(3);
      });

      test('keeps another tenant’s runs out of the list', async () => {
        const investigation = await saved(acme);
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
      async function hypothesisFor(investigation: Investigation, node: EvidenceNode) {
        const hypothesis = createHypothesis({
          orgId: investigation.orgId,
          investigationId: investigation.id,
          statement: 'The deploy did it.',
          confidence: 0.8,
          citations: [
            { label: 'E1', stance: 'supports' },
            { label: 'E2', stance: 'contradicts' },
          ],
          idMap: new Map([
            ['E1', node.id],
            ['E2', node.id],
          ]),
          model: 'gemini-2.5-flash',
          promptVersion: 'investigate/v1',
          evidenceSeen: [node.id],
          now: AT,
        });
        await store.hypotheses.save(investigation.orgId === acme.orgId ? acme : globex, hypothesis);
        return hypothesis;
      }

      test('lists what was concluded about an investigation', async () => {
        const investigation = await saved(acme);
        const node = alertNode(investigation);
        await store.evidence.append(acme, investigation.id, [node], []);
        await hypothesisFor(investigation, node);

        expect((await store.hypotheses.listFor(acme, investigation.id))[0]?.statement).toBe(
          'The deploy did it.',
        );
      });

      test('round-trips citations in order, with their stances and reproducibility metadata', async () => {
        // "Why did it conclude that?" is unanswerable without the model, the prompt version and the
        // evidence it saw — and a citation that lost its stance would read support into a
        // contradiction.
        const investigation = await saved(acme);
        const node = alertNode(investigation);
        await store.evidence.append(acme, investigation.id, [node], []);
        const hypothesis = await hypothesisFor(investigation, node);

        const [loaded] = await store.hypotheses.listFor(acme, investigation.id);

        expect(loaded).toEqual(hypothesis);
        expect(loaded?.citations.map((c) => c.stance)).toEqual(['supports', 'contradicts']);
        expect(loaded?.confidence).toBe(0.8);
      });

      test('keeps another tenant’s hypotheses out of the list', async () => {
        const investigation = await saved(acme);
        const node = alertNode(investigation);
        await store.evidence.append(acme, investigation.id, [node], []);
        await hypothesisFor(investigation, node);

        expect(await store.hypotheses.listFor(globex, investigation.id)).toEqual([]);
      });
    });

    describe('conversation links', () => {
      test('resolves a conversation to the investigation being discussed in it', async () => {
        // This is what lets a bare "why?" mean something.
        const investigation = await saved(acme);
        await store.conversations.link(acme, 'telegram:4821', investigation.id);

        expect(await store.conversations.resolve(acme, 'telegram:4821')).toBe(investigation.id);
      });

      test('re-links a conversation when a second investigation is discussed in it', async () => {
        const first = await saved(acme, 'INC-481');
        const second = await saved(acme, 'INC-902');
        await store.conversations.link(acme, 'telegram:4821', first.id);
        await store.conversations.link(acme, 'telegram:4821', second.id);

        expect(await store.conversations.resolve(acme, 'telegram:4821')).toBe(second.id);
      });

      test('does not leak a conversation across tenants', async () => {
        const investigation = await saved(acme);
        await store.conversations.link(acme, 'telegram:4821', investigation.id);

        expect(await store.conversations.resolve(globex, 'telegram:4821')).toBeUndefined();
      });
    });

    describe('reports', () => {
      async function reportFor(
        investigation: Investigation,
        node: EvidenceNode,
      ): Promise<InvestigationReport> {
        return {
          investigationId: investigation.id,
          orgId: investigation.orgId,
          summary: 'A deploy [E2] preceded the spike [E1].',
          hypotheses: [
            createHypothesis({
              orgId: investigation.orgId,
              investigationId: investigation.id,
              statement: 'The deploy did it.',
              confidence: 0.95,
              citations: [{ label: 'E1', stance: 'supports' }],
              idMap: new Map([['E1', node.id]]),
              model: 'gemini-2.5-flash',
              promptVersion: 'investigate/v1',
              evidenceSeen: [node.id],
              now: AT,
            }),
          ],
          timeline: [
            {
              label: 'E1',
              at: AT,
              kind: 'alert',
              summary: 'Elevated 5xx rate on payments-api',
              sourceUrl: 'https://pagerduty.example/INC-481',
            },
          ],
          missingInformation: ['datadog was not consulted: not configured'],
          suggestedQuestions: ['Was the connection pool resized?'],
          model: 'gemini-2.5-flash',
          promptVersion: 'investigate/v1',
          generatedAt: AT,
        };
      }

      test('returns the report an engineer was shown', async () => {
        const investigation = await saved(acme);
        const node = alertNode(investigation);
        await store.evidence.append(acme, investigation.id, [node], []);
        await store.reports.save(acme, await reportFor(investigation, node));

        expect((await store.reports.findFor(acme, investigation.id))?.summary).toContain('[E2]');
      });

      test('round-trips whole, so a follow-up explains this report and not a new one', async () => {
        // Reasoning is neither free nor deterministic. A report that lost its hypotheses on the way
        // to storage would be silently re-reasoned, and "why?" would justify a conclusion nobody
        // was ever shown.
        const investigation = await saved(acme);
        const node = alertNode(investigation);
        await store.evidence.append(acme, investigation.id, [node], []);
        const report = await reportFor(investigation, node);
        await store.reports.save(acme, report);

        expect(await store.reports.findFor(acme, investigation.id)).toEqual(report);
      });

      test('never returns another tenant’s report', async () => {
        const investigation = await saved(acme);
        const node = alertNode(investigation);
        await store.evidence.append(acme, investigation.id, [node], []);
        await store.reports.save(acme, await reportFor(investigation, node));

        expect(await store.reports.findFor(globex, investigation.id)).toBeUndefined();
      });
    });

    describe('similarity', () => {
      // Hand-written rather than model output: the contract is about storage and ranking, and a
      // test that needed an embedding model would not run without a key.
      //
      // Full width, though. `vector(768)` rejects anything else, so a three-element vector tests
      // the in-memory store and nothing else — which is exactly what it did until Postgres said so.
      const pool = axis(0);
      const poolish = blend(0.9, 0.1);
      const unrelated = axis(2);
      const MODEL = 'lexical-v1';

      async function indexed(ctx: TenantContext, id: string, embedding: readonly number[]) {
        const investigation = await saved(ctx, id);
        await store.similarity.index(ctx, {
          investigationId: investigation.id,
          embedding,
          sourceText: `payments-api ${id}`,
          model: MODEL,
        });
        return investigation;
      }

      test('finds the nearest prior investigation', async () => {
        const near = await indexed(acme, 'INC-302', poolish);
        await indexed(acme, 'INC-115', unrelated);

        const [first] = await store.similarity.findSimilar(acme, {
          embedding: pool,
          model: MODEL,
          limit: 5,
        });

        expect(first?.investigationId).toBe(near.id);
        expect(first?.externalRef.id).toBe('INC-302');
      });

      test('ranks by closeness and honours the limit', async () => {
        await indexed(acme, 'INC-302', poolish);
        await indexed(acme, 'INC-115', unrelated);

        const found = await store.similarity.findSimilar(acme, {
          embedding: pool,
          model: MODEL,
          limit: 1,
        });

        expect(found).toHaveLength(1);
        expect(found[0]?.externalRef.id).toBe('INC-302');
      });

      test('excludes the investigation being explained, its own nearest neighbour', async () => {
        const self = await indexed(acme, 'INC-481', pool);
        await indexed(acme, 'INC-302', poolish);

        const found = await store.similarity.findSimilar(acme, {
          embedding: pool,
          model: MODEL,
          limit: 5,
          exclude: self.id,
        });

        expect(found.map((s) => s.externalRef.id)).toEqual(['INC-302']);
      });

      test('scores an exact match at 1 and an opposite at 0', async () => {
        // The two stores compute this differently — JS here, `1 - (a <=> b)` in pgvector — so the
        // scale has to be asserted, not assumed, or a threshold tuned on one would misfire on the other.
        await indexed(acme, 'INC-302', pool);
        const [exact] = await store.similarity.findSimilar(acme, {
          embedding: pool,
          model: MODEL,
          limit: 1,
        });
        expect(exact?.score).toBeCloseTo(1, 5);

        const [opposite] = await store.similarity.findSimilar(acme, {
          embedding: pool.map((x) => -x),
          model: MODEL,
          limit: 1,
        });
        expect(opposite?.score).toBeCloseTo(0, 5);
      });

      test('replaces an investigation’s vector rather than adding a second', async () => {
        // An embedding is derived data — nothing cites it — so re-indexing after a better summary
        // must not leave the same incident in the results twice.
        const investigation = await indexed(acme, 'INC-302', unrelated);
        await store.similarity.index(acme, {
          investigationId: investigation.id,
          embedding: poolish,
          sourceText: 'payments-api INC-302 revised',
          model: 'lexical-v1',
        });

        const found = await store.similarity.findSimilar(acme, {
          embedding: pool,
          model: MODEL,
          limit: 5,
        });

        expect(found).toHaveLength(1);
        expect(found[0]?.score).toBeGreaterThan(0.9);
      });

      test('never matches a vector produced by a different embedding model', async () => {
        // Two models do not share a vector space, so a similarity across them is not a weak signal,
        // it is a meaningless number that still sorts. Seen in a live table: an incident indexed
        // lexically scored 0.4943 against a Gemini query that should have matched it, purely
        // because the operator had added an API key between the two runs.
        const priorModel = await indexed(acme, 'INC-302', poolish);
        await store.similarity.index(acme, {
          investigationId: priorModel.id,
          embedding: poolish,
          sourceText: 'payments-api INC-302',
          model: 'some-other-embedder-v2',
        });

        expect(
          await store.similarity.findSimilar(acme, {
            embedding: pool,
            model: 'lexical-v1',
            limit: 5,
          }),
        ).toEqual([]);
      });

      test('never returns another tenant’s incident history', async () => {
        // The most sensitive read in the system: "we have seen this before" across an org boundary
        // leaks that another company had an outage.
        await indexed(acme, 'INC-302', poolish);

        expect(
          await store.similarity.findSimilar(globex, { embedding: pool, model: MODEL, limit: 5 }),
        ).toEqual([]);
      });
    });
  });
}
