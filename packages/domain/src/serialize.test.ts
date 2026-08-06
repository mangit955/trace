import { beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createEvidenceEdge, createEvidenceNode } from './entities/evidence.ts';
import { buildEvidenceGraph } from './graph.ts';
import { CollectorRunId, InvestigationId, newId, OrgId } from './ids.ts';
import { registerCoreKinds } from './kinds/index.ts';
import { EvidenceKindRegistry } from './registry.ts';
import { serializeForReasoning } from './serialize.ts';

const orgId = newId(OrgId);
const investigationId = newId(InvestigationId);
const collectorRunId = newId(CollectorRunId);
const collectedAt = new Date('2026-08-06T10:20:00.000Z');

let registry: EvidenceKindRegistry;

beforeEach(() => {
  registry = new EvidenceKindRegistry();
  registerCoreKinds(registry);
});

function node(kind: string, payload: unknown, connector = 'test', version = 1) {
  return createEvidenceNode({
    registry,
    orgId,
    investigationId,
    kind,
    kindVersion: version,
    payload,
    connector,
    collectorRunId,
    collectedAt,
  });
}

const alert = () =>
  node('alert', {
    source: 'pagerduty',
    externalId: 'INC-481',
    title: 'Elevated 5xx rate',
    severity: 'critical',
    service: 'payments-api',
    firedAt: '2026-08-06T10:16:00.000Z',
    url: 'https://acme.pagerduty.com/incidents/INC-481',
  });

const deployment = (version = 'v2.4.1') =>
  node('deployment', {
    service: 'payments-api',
    version,
    environment: 'production',
    status: 'succeeded',
    deployedAt: '2026-08-06T10:12:00.000Z',
    deployedBy: 'ci-bot',
  });

const logPattern = (pattern: string) =>
  node('log_pattern', {
    service: 'payments-api',
    level: 'error',
    pattern,
    count: 4127,
    firstSeenAt: '2026-08-06T10:13:00.000Z',
    lastSeenAt: '2026-08-06T10:19:00.000Z',
  });

function graphOf(nodes: ReturnType<typeof node>[], edges = []) {
  return buildEvidenceGraph({ investigationId, nodes, edges });
}

describe('determinism', () => {
  test('produces byte-identical text for the same graph', () => {
    // Prompt caching and reproducible reports both depend on this. If the same evidence can
    // produce two different prompts, "why did it say that" becomes unanswerable.
    const graph = graphOf([alert(), deployment(), logPattern('redis pool exhausted')]);

    expect(serializeForReasoning(graph, registry).text).toBe(
      serializeForReasoning(graph, registry).text,
    );
  });

  test('is unaffected by the order evidence arrived in', () => {
    const a = alert();
    const d = deployment();
    const forward = graphOf([a, d]);
    const reverse = graphOf([d, a]);

    expect(serializeForReasoning(forward, registry).text).toBe(
      serializeForReasoning(reverse, registry).text,
    );
  });
});

describe('citation addressing', () => {
  test('labels every included node with a short id', () => {
    const { text } = serializeForReasoning(graphOf([alert(), deployment()]), registry);
    expect(text).toContain('[E1]');
    expect(text).toContain('[E2]');
  });

  test('maps every short id back to a real node', () => {
    const graph = graphOf([alert(), deployment()]);
    const { idMap } = serializeForReasoning(graph, registry);

    const ids = graph.nodes.map((n) => n.id);
    for (const nodeId of idMap.values()) {
      expect(ids).toContain(nodeId);
    }
  });

  test('numbers ascend in reading order so a human can follow a citation', () => {
    const { text } = serializeForReasoning(
      graphOf([alert(), deployment(), logPattern('x')]),
      registry,
    );
    const order = [...text.matchAll(/\[E(\d+)]/g)].map((m) => Number(m[1]));

    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('content', () => {
  test('states the evidence window', () => {
    const { text } = serializeForReasoning(graphOf([alert()]), registry);
    expect(text).toContain('2026-08-06T10:16:00.000Z');
  });

  test('includes deep links so claims can be verified', () => {
    const { text } = serializeForReasoning(graphOf([alert()]), registry);
    expect(text).toContain('https://acme.pagerduty.com/incidents/INC-481');
  });

  test('renders relations, since the graph structure is evidence too', () => {
    const a = alert();
    const d = deployment();
    const edge = createEvidenceEdge({
      orgId,
      investigationId,
      from: d.id,
      to: a.id,
      relation: 'PRECEDED',
    });
    const graph = buildEvidenceGraph({ investigationId, nodes: [a, d], edges: [edge] });

    expect(serializeForReasoning(graph, registry).text).toContain('PRECEDED');
  });

  test('lists relations in label order rather than alphabetically', () => {
    // Sorting the rendered strings puts E11 before E2, so the relation list stops tracking the
    // evidence list above it and both a human and the model have to hunt.
    const a = alert();
    const logs = Array.from({ length: 10 }, (_, i) => logPattern(`pattern ${i}`));
    const edge = (from: typeof a.id) =>
      createEvidenceEdge({ orgId, investigationId, from, to: a.id, relation: 'PRECEDED' });
    const graph = buildEvidenceGraph({
      investigationId,
      nodes: [a, ...logs],
      edges: [edge(logs[9]?.id ?? a.id), edge(logs[0]?.id ?? a.id)],
    });

    const { text } = serializeForReasoning(graph, registry);

    expect(text).toContain('E2 PRECEDED E1\nE11 PRECEDED E1');
  });

  test('says so plainly when there is no evidence at all', () => {
    const { text } = serializeForReasoning(graphOf([]), registry);
    expect(text).toMatch(/no evidence/i);
  });
});

describe('plugin kinds degrade gracefully', () => {
  beforeEach(() => {
    registry.register({
      kind: 'vendor.acme.widget',
      version: 1,
      schema: z.object({ name: z.string(), at: z.iso.datetime() }),
      examples: [{ name: 'w', at: '2026-08-06T10:14:00.000Z' }],
      identity: (p) => p.name,
      summarize: (p) => `Acme widget ${p.name} tripped`,
      timestamps: (p) => ({ occurredAt: new Date(p.at) }),
    });
  });

  test('renders an unknown kind using its own summary', () => {
    const widget = node('vendor.acme.widget', { name: 'w1', at: '2026-08-06T10:14:00.000Z' });
    const { text } = serializeForReasoning(graphOf([alert(), widget]), registry);

    expect(text).toContain('Acme widget w1 tripped');
  });
});

describe('budget', () => {
  test('drops low-signal evidence before high-signal evidence', () => {
    const patterns = Array.from({ length: 40 }, (_, i) => logPattern(`pattern number ${i}`));
    const graph = graphOf([alert(), deployment(), ...patterns]);

    const { text } = serializeForReasoning(graph, registry, { budgetChars: 900 });

    expect(text).toContain('Elevated 5xx rate');
    expect(text).toContain('Deployed payments-api');
  });

  test('never drops the alert, even at an absurdly small budget', () => {
    // The alert is the thing being investigated. A report that omits it is meaningless.
    const patterns = Array.from({ length: 40 }, (_, i) => logPattern(`pattern number ${i}`));
    const graph = graphOf([alert(), ...patterns]);

    expect(serializeForReasoning(graph, registry, { budgetChars: 1 }).text).toContain(
      'Elevated 5xx rate',
    );
  });

  test('reports how much was omitted, rather than silently truncating', () => {
    // Silent truncation would make the model confident about evidence it never saw.
    const patterns = Array.from({ length: 40 }, (_, i) => logPattern(`pattern number ${i}`));
    const graph = graphOf([alert(), ...patterns]);

    const result = serializeForReasoning(graph, registry, { budgetChars: 900 });

    expect(result.elided).toBeGreaterThan(0);
    expect(result.text).toMatch(/omitted/i);
  });

  test('elides nothing when everything fits', () => {
    const result = serializeForReasoning(graphOf([alert(), deployment()]), registry);
    expect(result.elided).toBe(0);
    expect(result.text).not.toMatch(/omitted/i);
  });

  test('only maps short ids for evidence actually included', () => {
    const patterns = Array.from({ length: 40 }, (_, i) => logPattern(`pattern number ${i}`));
    const graph = graphOf([alert(), ...patterns]);

    const result = serializeForReasoning(graph, registry, { budgetChars: 900 });

    expect(result.idMap.size).toBe(graph.nodes.length - result.elided);
  });
});
