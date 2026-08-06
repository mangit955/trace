import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  CollectorRunId,
  completeCollectorRun,
  createEvidenceNode,
  createInvestigation,
  defaultWindowFor,
  type EvidenceGraph,
  EvidenceKindRegistry,
  failCollectorRun,
  HallucinatedCitationError,
  type Investigation,
  newId,
  OrgId,
  registerCoreKinds,
  startCollectorRun,
  UngroundedClaimError,
} from '@trace/domain';
import type { Reasoner } from './reasoner.ts';
import { reasonAboutInvestigation } from './report.ts';

const ALERT_AT = new Date('2026-08-06T10:16:00.000Z');

const registry = new EvidenceKindRegistry();
registerCoreKinds(registry);

const target: Investigation = createInvestigation({
  orgId: newId(OrgId),
  externalRef: { system: 'pagerduty', id: 'INC-481' },
  window: defaultWindowFor(ALERT_AT),
  now: ALERT_AT,
});

const collectorRunId = newId(CollectorRunId);

function node(kind: string, payload: unknown) {
  return createEvidenceNode({
    registry,
    orgId: target.orgId,
    investigationId: target.id,
    kind,
    kindVersion: 1,
    payload,
    connector: 'test',
    collectorRunId,
    collectedAt: ALERT_AT,
  });
}

/** E1 is the alert, E2 the deployment — ordered by section, per the serializer. */
function graphOf(): EvidenceGraph {
  const alert = node('alert', {
    source: 'pagerduty',
    externalId: 'INC-481',
    title: 'Elevated 5xx rate on payments-api',
    severity: 'critical',
    service: 'payments-api',
    firedAt: ALERT_AT.toISOString(),
  });
  const deploy = node('deployment', {
    service: 'payments-api',
    version: 'v2.4.1',
    environment: 'production',
    status: 'succeeded',
    deployedAt: '2026-08-06T10:12:00.000Z',
    deployedBy: 'ci-bot',
  });

  return buildEvidenceGraph({ investigationId: target.id, nodes: [alert, deploy], edges: [] });
}

const runs = [
  completeCollectorRun(
    startCollectorRun({
      orgId: target.orgId,
      investigationId: target.id,
      collector: 'github',
      now: ALERT_AT,
    }),
    2,
    ALERT_AT,
  ),
  failCollectorRun(
    startCollectorRun({
      orgId: target.orgId,
      investigationId: target.id,
      collector: 'datadog',
      now: ALERT_AT,
    }),
    'request timed out',
    ALERT_AT,
  ),
];

/** A reasoner returning exactly what it is told to, so the gate can be tested in isolation. */
function stubReasoner(output: unknown): Reasoner {
  return {
    name: 'stub',
    model: 'stub-1',
    reason: async () => output as never,
  };
}

const sound = {
  summary: 'A deploy [E2] preceded a 5xx spike [E1].',
  hypotheses: [
    {
      statement: 'The v2.4.1 deployment introduced the regression.',
      confidence: 0.86,
      citations: [
        { label: 'E2', stance: 'supports' as const },
        { label: 'E1', stance: 'supports' as const },
      ],
    },
  ],
  suggestedQuestions: ['Was the deploy rolled back?'],
};

function report(output: unknown) {
  return reasonAboutInvestigation({
    investigation: target,
    graph: graphOf(),
    registry,
    runs,
    reasoner: stubReasoner(output),
    now: ALERT_AT,
  });
}

describe('reasonAboutInvestigation', () => {
  test('carries the model summary through', async () => {
    expect((await report(sound)).summary).toBe('A deploy [E2] preceded a 5xx spike [E1].');
  });

  test('turns model claims into hypotheses whose citations resolve to real nodes', async () => {
    const { hypotheses } = await report(sound);
    const nodeIds = graphOf().nodes.map((n) => n.kind);

    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]?.citations).toHaveLength(2);
    expect(hypotheses[0]?.promptVersion).toBe('investigate/v1');
    expect(nodeIds).toContain('deployment');
  });

  test('rejects a response citing evidence that was never shown', async () => {
    // The whole response, not just the offending hypothesis: a report is a single claim about
    // what happened, and shipping the half that survived would misrepresent it.
    const hallucinated = {
      ...sound,
      hypotheses: [{ ...sound.hypotheses[0], citations: [{ label: 'E99', stance: 'supports' }] }],
    };

    expect(report(hallucinated)).rejects.toBeInstanceOf(HallucinatedCitationError);
  });

  test('rejects a claim that cites nothing at all', async () => {
    const ungrounded = {
      ...sound,
      hypotheses: [{ ...sound.hypotheses[0], citations: [] }],
    };

    expect(report(ungrounded)).rejects.toBeInstanceOf(UngroundedClaimError);
  });

  test('rejects output that does not match the expected shape', async () => {
    expect(report({ summary: 'no hypotheses field' })).rejects.toThrow(/reasoner/i);
  });

  test('computes the timeline from the evidence, in the order events occurred', async () => {
    const { timeline } = await report(sound);

    expect(timeline.map((entry) => entry.label)).toEqual(['E2', 'E1']);
    expect(timeline[0]?.summary).toContain('Deployed payments-api v2.4.1');
  });

  test('leaves out evidence that is not an event', async () => {
    // A topology snapshot and a five-month-old incident are context, not sequence. Rendered in a
    // timeline they read as things that happened during this incident, and the March date at the
    // top of an August incident is actively misleading.
    const withContext = buildEvidenceGraph({
      investigationId: target.id,
      nodes: [
        ...graphOf().nodes,
        node('service', {
          name: 'payments-api',
          tier: 'tier1',
          dependsOn: [],
          snapshotAt: ALERT_AT.toISOString(),
        }),
        node('past_incident', {
          externalId: 'INC-302',
          title: 'Redis connection pool exhaustion',
          occurredAt: '2026-03-14T02:41:00.000Z',
          affectedServices: ['payments-api'],
        }),
      ],
      edges: [],
    });

    const produced = await reasonAboutInvestigation({
      investigation: target,
      graph: withContext,
      registry,
      runs,
      reasoner: stubReasoner(sound),
      now: ALERT_AT,
    });

    expect(produced.timeline.map((entry) => entry.kind)).toEqual(['deployment', 'alert']);
  });

  test('still lets the model cite the context it left out of the timeline', async () => {
    // Excluded from the sequence, not from the evidence: precedent is often the most useful thing
    // in the graph, and a hypothesis must still be able to cite it.
    const withPast = buildEvidenceGraph({
      investigationId: target.id,
      nodes: [
        ...graphOf().nodes,
        node('past_incident', {
          externalId: 'INC-302',
          title: 'Redis connection pool exhaustion',
          occurredAt: '2026-03-14T02:41:00.000Z',
          affectedServices: ['payments-api'],
        }),
      ],
      edges: [],
    });

    const citingPast = {
      ...sound,
      hypotheses: [
        { ...sound.hypotheses[0], citations: [{ label: 'E2', stance: 'supports' as const }] },
      ],
    };

    const produced = await reasonAboutInvestigation({
      investigation: target,
      graph: withPast,
      registry,
      runs,
      reasoner: stubReasoner(citingPast),
      now: ALERT_AT,
    });

    expect(produced.hypotheses[0]?.evidenceSeen).toHaveLength(3);
  });

  test('computes missing information from collector runs, not from the model', async () => {
    // Invariant 4. The model cannot introspect what it was never shown, so even a confident,
    // well-formed list from the model must not reach the report.
    const inventive = { ...sound, missingInformation: ['the moon phase was unavailable'] };

    const { missingInformation } = await report(inventive);

    expect(missingInformation).toEqual(['datadog failed: request timed out']);
  });

  test('records which model produced it, so a stored report is reproducible', async () => {
    const produced = await report(sound);

    expect(produced.model).toBe('stub-1');
    expect(produced.promptVersion).toBe('investigate/v1');
    expect(produced.generatedAt).toEqual(ALERT_AT);
  });

  test('passes the computed gaps to the reasoner, so it does not overclaim', async () => {
    let seen: readonly string[] = [];
    await reasonAboutInvestigation({
      investigation: target,
      graph: graphOf(),
      registry,
      runs,
      reasoner: {
        name: 'spy',
        model: 'spy-1',
        reason: async (request) => {
          seen = request.gaps;
          return sound;
        },
      },
      now: ALERT_AT,
    });

    expect(seen).toEqual(['datadog failed: request timed out']);
  });
});
