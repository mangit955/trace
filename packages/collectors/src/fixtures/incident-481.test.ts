import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  missingInformationFrom,
  newId,
  OrgId,
  registerCoreKinds,
  serializeForReasoning,
  systemClock,
} from '@trace/domain';
import { collectEvidence } from '../runner.ts';
import { fixtureCollectors, INC_481 } from './incident-481.ts';

/**
 * The seeded incident is the demo. A reviewer with no credentials sees exactly this, so it is
 * tested as a product surface rather than as test data: every payload must satisfy its kind's real
 * schema, every relation must resolve, and the prompt text must read like an incident.
 */
describe('the seeded INC-481 incident', () => {
  async function collect() {
    const registry = new EvidenceKindRegistry();
    registerCoreKinds(registry);

    const investigation = createInvestigation({
      orgId: newId(OrgId),
      externalRef: INC_481.externalRef,
      window: defaultWindowFor(INC_481.alertAt),
      now: INC_481.alertAt,
    });

    const result = await collectEvidence({
      collectors: fixtureCollectors(INC_481),
      investigation,
      registry,
      clock: systemClock,
    });

    const graph = buildEvidenceGraph({
      investigationId: investigation.id,
      nodes: result.nodes,
      edges: result.edges,
    });

    return { ...result, graph, text: serializeForReasoning(graph, registry).text };
  }

  test('every source succeeds, so the demo has no unexplained blind spots', async () => {
    const { runs } = await collect();

    expect(runs.length).toBeGreaterThan(3);
    expect(missingInformationFrom(runs)).toEqual([]);
  });

  test('builds a graph in which every relation resolves', async () => {
    const { graph, edges } = await collect();

    expect(graph.nodes.length).toBeGreaterThan(10);
    expect(graph.edges).toHaveLength(edges.length);
    expect(edges.length).toBeGreaterThan(5);
  });

  test('opens on the alert the investigation mirrors', async () => {
    const { text } = await collect();

    expect(text).toContain('[critical] Elevated 5xx rate on payments-api');
  });

  test('reconstructs the change that preceded it', async () => {
    const { text } = await collect();

    expect(text).toContain('Deployed payments-api v2.4.1 (from v2.4.0)');
    expect(text).toContain('REDIS_POOL_MAX');
  });

  test('spans more than one service, so blast radius is visible', async () => {
    const { text } = await collect();

    expect(text).toContain('checkout-web');
  });

  test('surfaces the matching past incident', async () => {
    const { text } = await collect();

    expect(text).toContain('INC-302');
  });

  test('states no causal relation anywhere in the evidence', async () => {
    // Causation is a claim; claims live in Hypothesis, with citations a human can check.
    const { text } = await collect();

    expect(text).not.toContain('CAUSED_BY');
  });

  test('serializes byte-identically across collections', async () => {
    const [first, second] = await Promise.all([collect(), collect()]);

    expect(first.text).toBe(second.text);
  });
});
