import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  completeCollectorRun,
  createEvidenceEdge,
  createEvidenceNode,
  createHypothesis,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  failCollectorRun,
  missingInformationFrom,
  newId,
  OrgId,
  registerCoreKinds,
  serializeForReasoning,
  startCollectorRun,
  transition,
} from './index.ts';

/**
 * Exercises a whole investigation through the public entry point only.
 *
 * Every other test imports modules directly, so nothing else would notice a barrel file that
 * forgot an export or a circular import between entities and citations.
 */
describe('a complete investigation via the public API', () => {
  const orgId = newId(OrgId);
  const firedAt = new Date('2026-08-06T10:16:00.000Z');

  function run() {
    const registry = new EvidenceKindRegistry();
    registerCoreKinds(registry);

    const investigation = createInvestigation({
      orgId,
      externalRef: { system: 'pagerduty', id: 'INC-481' },
      window: defaultWindowFor(firedAt),
      now: firedAt,
    });

    const collecting = transition(investigation, 'collecting', firedAt);

    const github = startCollectorRun({
      orgId,
      investigationId: collecting.id,
      collector: 'github',
      now: firedAt,
    });
    const datadog = startCollectorRun({
      orgId,
      investigationId: collecting.id,
      collector: 'datadog',
      now: firedAt,
    });

    const node = (kind: string, payload: unknown, connector: string) =>
      createEvidenceNode({
        registry,
        orgId,
        investigationId: collecting.id,
        kind,
        kindVersion: 1,
        payload,
        connector,
        collectorRunId: github.id,
        collectedAt: firedAt,
      });

    const alert = node(
      'alert',
      {
        source: 'pagerduty',
        externalId: 'INC-481',
        title: 'Elevated 5xx rate on payments-api',
        severity: 'critical',
        service: 'payments-api',
        firedAt: firedAt.toISOString(),
      },
      'pagerduty',
    );

    const deploy = node(
      'deployment',
      {
        service: 'payments-api',
        version: 'v2.4.1',
        environment: 'production',
        status: 'succeeded',
        deployedAt: '2026-08-06T10:12:00.000Z',
        deployedBy: 'ci-bot',
      },
      'github',
    );

    const graph = buildEvidenceGraph({
      investigationId: collecting.id,
      nodes: [alert, deploy],
      edges: [
        createEvidenceEdge({
          orgId,
          investigationId: collecting.id,
          from: deploy.id,
          to: alert.id,
          relation: 'PRECEDED',
        }),
      ],
    });

    const serialized = serializeForReasoning(graph, registry);

    const runs = [
      completeCollectorRun(github, 2, firedAt),
      failCollectorRun(datadog, 'request timed out', firedAt),
    ];

    const deployLabel = [...serialized.idMap.entries()].find(
      ([, nodeId]) => nodeId === deploy.id,
    )?.[0];

    const hypothesis = createHypothesis({
      orgId,
      investigationId: collecting.id,
      statement: 'The v2.4.1 deployment preceded the error spike.',
      confidence: 0.87,
      citations: [{ label: deployLabel ?? 'E1', stance: 'supports' }],
      idMap: serialized.idMap,
      model: 'gemini-2.5-flash',
      promptVersion: 'investigate/v1',
      evidenceSeen: graph.nodes.map((n) => n.id),
      now: firedAt,
    });

    const ready = transition(transition(collecting, 'reasoning', firedAt), 'ready', firedAt);

    return { serialized, runs, hypothesis, ready };
  }

  test('reaches a ready state', () => {
    expect(run().ready.status).toBe('ready');
  });

  test('produces prompt text citing the collected evidence', () => {
    expect(run().serialized.text).toContain('Deployed payments-api v2.4.1');
  });

  test('produces a hypothesis whose citation resolves to a real node', () => {
    const { hypothesis, serialized } = run();
    const cited = hypothesis.citations[0];

    expect(cited).toBeDefined();
    expect(serialized.idMap.get(cited?.label ?? '')).toBe(cited?.nodeId);
  });

  test('reports the failed collector as a known blind spot', () => {
    // The gap comes from the collector run, not from asking the model what it does not know.
    expect(missingInformationFrom(run().runs).join()).toContain('datadog');
  });

  test('is deterministic end to end', () => {
    expect(run().serialized.text).toBe(run().serialized.text);
  });
});
