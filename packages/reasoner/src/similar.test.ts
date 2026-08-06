import { describe, expect, test } from 'bun:test';
import { collectEvidence } from '@trace/collectors';
import { fixtureCollectors, SEEDED_INCIDENTS } from '@trace/collectors/fixtures';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  newId,
  OrgId,
  registerCoreKinds,
  systemClock,
} from '@trace/domain';
import { lexicalEmbedder } from './embed.ts';
import { similaritySourceText } from './similar.ts';

/**
 * Driven off the real seeded incident rather than a two-node synthetic graph.
 *
 * A hand-built graph would only prove the function reads the fields the test put there. The point
 * of this text is what it picks out of a *realistic* graph — one with a decoy flag change, a
 * redacted credential rotation and seven sources — and whether that is enough to match on.
 */

const registry = new EvidenceKindRegistry();
registerCoreKinds(registry);

function seeded() {
  const incident = SEEDED_INCIDENTS['INC-481'];
  if (!incident) throw new Error('INC-481 fixture is missing.');
  return incident;
}

async function graphFor() {
  const incident = seeded();

  const investigation = createInvestigation({
    orgId: newId(OrgId),
    externalRef: incident.externalRef,
    window: defaultWindowFor(incident.alertAt),
    now: new Date('2026-08-06T10:20:00.000Z'),
  });

  const collected = await collectEvidence({
    collectors: fixtureCollectors(incident),
    investigation,
    registry,
    clock: systemClock,
  });

  return buildEvidenceGraph({
    investigationId: investigation.id,
    nodes: collected.nodes,
    edges: collected.edges,
  });
}

describe('similaritySourceText', () => {
  test('names the services the incident touched', async () => {
    const text = similaritySourceText({ graph: await graphFor(), registry });

    expect(text).toContain('payments-api');
  });

  test('carries the error signature, which is what an engineer matches on', async () => {
    const text = similaritySourceText({ graph: await graphFor(), registry });

    expect(text.toLowerCase()).toContain('5xx');
  });

  test('is byte-identical for the same graph, so re-indexing does not move the incident', async () => {
    // Same reason `serialize.ts` is deterministic: a vector that drifts makes "have we seen this
    // before" answer differently on Tuesday than it did on Monday, with nothing having changed.
    const graph = await graphFor();

    expect(similaritySourceText({ graph, registry })).toBe(
      similaritySourceText({ graph, registry }),
    );
  });

  test('works with no report, because reasoning can fail and the incident is still worth indexing', async () => {
    const text = similaritySourceText({ graph: await graphFor(), registry });

    expect(text.length).toBeGreaterThan(0);
  });

  test('places a similar incident nearer than an unrelated one, end to end', async () => {
    // The claim the whole feature rests on, checked through the embedder rather than asserted.
    const embedder = lexicalEmbedder();
    const text = similaritySourceText({ graph: await graphFor(), registry });

    const self = await embedder.embed(text);
    const related = await embedder.embed(
      'payments-api Elevated 5xx rate on payments-api redis connection pool exhausted',
    );
    const unrelated = await embedder.embed(
      'marketing-site broken image links after a CMS migration',
    );

    expect(dot(self, related)).toBeGreaterThan(dot(self, unrelated));
  });
});

function dot(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += (a[i] ?? 0) * (b[i] ?? 0);
  return total;
}
