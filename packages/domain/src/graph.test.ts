import { beforeEach, describe, expect, test } from 'bun:test';
import { createEvidenceEdge, createEvidenceNode } from './entities/evidence.ts';
import { buildEvidenceGraph, neighboursOf, nodesOfKind } from './graph.ts';
import { CollectorRunId, EvidenceNodeId, InvestigationId, newId, OrgId } from './ids.ts';
import { registerCoreKinds } from './kinds/index.ts';
import { EvidenceKindRegistry } from './registry.ts';

const orgId = newId(OrgId);
const investigationId = newId(InvestigationId);
const collectorRunId = newId(CollectorRunId);

let registry: EvidenceKindRegistry;

beforeEach(() => {
  registry = new EvidenceKindRegistry();
  registerCoreKinds(registry);
});

function deploymentNode(at: string, version = 'v2.4.1', investigation = investigationId) {
  return createEvidenceNode({
    registry,
    orgId,
    investigationId: investigation,
    kind: 'deployment',
    kindVersion: 1,
    payload: {
      service: 'payments-api',
      version,
      environment: 'production',
      status: 'succeeded',
      deployedAt: at,
      deployedBy: 'ci-bot',
    },
    connector: 'github',
    collectorRunId,
    collectedAt: new Date('2026-08-06T10:20:00.000Z'),
  });
}

function alertNode(at: string) {
  return createEvidenceNode({
    registry,
    orgId,
    investigationId,
    kind: 'alert',
    kindVersion: 1,
    payload: {
      source: 'pagerduty',
      externalId: 'INC-481',
      title: 'Elevated 5xx rate',
      severity: 'critical',
      service: 'payments-api',
      firedAt: at,
    },
    connector: 'pagerduty',
    collectorRunId,
    collectedAt: new Date('2026-08-06T10:20:00.000Z'),
  });
}

describe('an empty graph', () => {
  test('is valid, because an investigation with no evidence is a real outcome', () => {
    const graph = buildEvidenceGraph({ investigationId, nodes: [], edges: [] });
    expect(graph.nodes).toHaveLength(0);
  });
});

describe('scoping invariants', () => {
  test('rejects a node belonging to a different investigation', () => {
    const foreign = deploymentNode('2026-08-06T10:12:00.000Z', 'v1', newId(InvestigationId));
    expect(() => buildEvidenceGraph({ investigationId, nodes: [foreign], edges: [] })).toThrow(
      'investigation',
    );
  });

  test('rejects an edge belonging to a different investigation', () => {
    const a = deploymentNode('2026-08-06T10:12:00.000Z', 'v1');
    const b = alertNode('2026-08-06T10:16:00.000Z');
    const foreignEdge = createEvidenceEdge({
      orgId,
      investigationId: newId(InvestigationId),
      from: a.id,
      to: b.id,
      relation: 'PRECEDED',
    });

    expect(() =>
      buildEvidenceGraph({ investigationId, nodes: [a, b], edges: [foreignEdge] }),
    ).toThrow('investigation');
  });
});

describe('dangling edges', () => {
  test('rejects an edge whose source node is absent', () => {
    const b = alertNode('2026-08-06T10:16:00.000Z');
    const edge = createEvidenceEdge({
      orgId,
      investigationId,
      from: newId(EvidenceNodeId),
      to: b.id,
      relation: 'PRECEDED',
    });

    expect(() => buildEvidenceGraph({ investigationId, nodes: [b], edges: [edge] })).toThrow(
      /dangling/i,
    );
  });

  test('rejects an edge whose target node is absent', () => {
    const a = deploymentNode('2026-08-06T10:12:00.000Z');
    const missing = alertNode('2026-08-06T10:16:00.000Z');
    const edge = createEvidenceEdge({
      orgId,
      investigationId,
      from: a.id,
      to: missing.id,
      relation: 'PRECEDED',
    });

    expect(() => buildEvidenceGraph({ investigationId, nodes: [a], edges: [edge] })).toThrow(
      /dangling/i,
    );
  });
});

describe('deduplication', () => {
  test('collapses two collections of the same evidence into one node', () => {
    // Collectors re-run. Without this the timeline shows the same deploy twice and the reasoner
    // treats repetition as corroboration.
    const first = deploymentNode('2026-08-06T10:12:00.000Z');
    const second = deploymentNode('2026-08-06T10:12:00.000Z');

    const graph = buildEvidenceGraph({ investigationId, nodes: [first, second], edges: [] });

    expect(graph.nodes).toHaveLength(1);
  });

  test('keeps distinct evidence distinct', () => {
    const a = deploymentNode('2026-08-06T10:12:00.000Z', 'v2.4.1');
    const b = deploymentNode('2026-08-06T10:12:00.000Z', 'v2.4.2');

    const graph = buildEvidenceGraph({ investigationId, nodes: [a, b], edges: [] });

    expect(graph.nodes).toHaveLength(2);
  });

  test('is order-independent, so the same evidence always yields the same graph', () => {
    const a = deploymentNode('2026-08-06T10:12:00.000Z');
    const b = deploymentNode('2026-08-06T10:12:00.000Z');

    const forward = buildEvidenceGraph({ investigationId, nodes: [a, b], edges: [] });
    const reverse = buildEvidenceGraph({ investigationId, nodes: [b, a], edges: [] });

    expect(forward.nodes.map((n) => n.id)).toEqual(reverse.nodes.map((n) => n.id));
  });
});

describe('ordering', () => {
  test('orders nodes by when the event happened, not when it was collected', () => {
    const later = alertNode('2026-08-06T10:16:00.000Z');
    const earlier = deploymentNode('2026-08-06T10:12:00.000Z');

    const graph = buildEvidenceGraph({ investigationId, nodes: [later, earlier], edges: [] });

    expect(graph.nodes.map((n) => n.kind)).toEqual(['deployment', 'alert']);
  });

  test('breaks ties deterministically regardless of input order', () => {
    // Byte-identical prompt text depends on this. Two events sharing a timestamp is common —
    // a deploy and the config change that shipped with it.
    const sameTime = '2026-08-06T10:12:00.000Z';
    const a = deploymentNode(sameTime, 'v1');
    const b = deploymentNode(sameTime, 'v2');
    const c = alertNode(sameTime);

    const one = buildEvidenceGraph({ investigationId, nodes: [a, b, c], edges: [] });
    const two = buildEvidenceGraph({ investigationId, nodes: [c, b, a], edges: [] });

    expect(one.nodes.map((n) => n.id)).toEqual(two.nodes.map((n) => n.id));
  });
});

describe('queries', () => {
  test('nodesOfKind selects a single evidence type', () => {
    const graph = buildEvidenceGraph({
      investigationId,
      nodes: [deploymentNode('2026-08-06T10:12:00.000Z'), alertNode('2026-08-06T10:16:00.000Z')],
      edges: [],
    });

    expect(nodesOfKind(graph, 'deployment')).toHaveLength(1);
  });

  test('neighboursOf walks edges in both directions', () => {
    const deploy = deploymentNode('2026-08-06T10:12:00.000Z');
    const alert = alertNode('2026-08-06T10:16:00.000Z');
    const edge = createEvidenceEdge({
      orgId,
      investigationId,
      from: deploy.id,
      to: alert.id,
      relation: 'PRECEDED',
    });

    const graph = buildEvidenceGraph({ investigationId, nodes: [deploy, alert], edges: [edge] });

    expect(neighboursOf(graph, deploy.id).map((n) => n.id)).toEqual([alert.id]);
    expect(neighboursOf(graph, alert.id).map((n) => n.id)).toEqual([deploy.id]);
  });
});
