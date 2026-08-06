import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  type Clock,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  type Investigation,
  missingInformationFrom,
  newId,
  OrgId,
  registerCoreKinds,
} from '@trace/domain';
import { type Collector, evidenceKey } from './collector.ts';
import { collectEvidence } from './runner.ts';

const ALERT_AT = new Date('2026-08-06T10:16:00.000Z');

function registry(): EvidenceKindRegistry {
  const created = new EvidenceKindRegistry();
  registerCoreKinds(created);
  return created;
}

function investigation(): Investigation {
  return createInvestigation({
    orgId: newId(OrgId),
    externalRef: { system: 'pagerduty', id: 'INC-481' },
    window: defaultWindowFor(ALERT_AT),
    now: ALERT_AT,
  });
}

/** Advances a fixed amount per read, so collector durations are distinguishable but replayable. */
function steppingClock(start: Date, stepMs = 1000): Clock {
  let next = start.getTime();
  return {
    now: () => {
      const at = new Date(next);
      next += stepMs;
      return at;
    },
  };
}

const deployPayload = {
  service: 'payments-api',
  version: 'v2.4.1',
  environment: 'production',
  status: 'succeeded',
  deployedAt: '2026-08-06T10:12:00.000Z',
  deployedBy: 'ci-bot',
};

/** A collector that returns exactly what it is given. */
function stubCollector(
  name: string,
  drafts: readonly { kind: string; payload: unknown }[],
): Collector {
  return {
    name,
    collect: async () => ({
      evidence: drafts.map((draft) => ({ kind: draft.kind, version: 1, payload: draft.payload })),
    }),
  };
}

const alertPayload = {
  source: 'pagerduty',
  externalId: 'INC-481',
  title: 'Elevated 5xx rate on payments-api',
  severity: 'critical',
  service: 'payments-api',
  firedAt: ALERT_AT.toISOString(),
};

/** A collector returning a deployment, the alert it preceded, and the relation between them. */
function relatingCollector(name: string): Collector {
  return {
    name,
    collect: async () => ({
      evidence: [
        { kind: 'deployment', version: 1, payload: deployPayload },
        { kind: 'alert', version: 1, payload: alertPayload },
      ],
      relations: [
        {
          from: evidenceKey('deployment', 1, 'payments-api:production:v2.4.1'),
          to: evidenceKey('alert', 1, 'pagerduty:INC-481'),
          relation: 'PRECEDED',
        },
      ],
    }),
  };
}

async function collect(collectors: readonly Collector[]) {
  const target = investigation();
  return await collectEvidence({
    collectors,
    investigation: target,
    registry: registry(),
    clock: steppingClock(ALERT_AT),
  });
}

describe('collectEvidence', () => {
  test('validates collector drafts into evidence nodes stamped with provenance', async () => {
    const result = await collect([
      stubCollector('github', [{ kind: 'deployment', payload: deployPayload }]),
    ]);

    const node = result.nodes[0];
    expect(result.nodes).toHaveLength(1);
    expect(node?.kind).toBe('deployment');
    expect(node?.connector).toBe('github');
    expect(node?.occurredAt).toEqual(new Date('2026-08-06T10:12:00.000Z'));
    expect(node?.collectorRunId).toBe(result.runs[0]?.id);
  });

  test('records a succeeded run carrying the node count', async () => {
    const result = await collect([
      stubCollector('github', [{ kind: 'deployment', payload: deployPayload }]),
    ]);

    expect(result.runs[0]?.status).toBe('succeeded');
    expect(result.runs[0]?.nodeCount).toBe(1);
  });

  test('keeps the evidence of healthy collectors when another throws', async () => {
    const exploding: Collector = {
      name: 'datadog',
      collect: async () => {
        throw new Error('request timed out after 30s');
      },
    };

    const result = await collect([
      exploding,
      stubCollector('github', [{ kind: 'deployment', payload: deployPayload }]),
    ]);

    expect(result.nodes).toHaveLength(1);
    const failed = result.runs.find((run) => run.collector === 'datadog');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('request timed out after 30s');
  });

  test('skips an unconfigured collector rather than failing it', async () => {
    const unconfigured: Collector = {
      name: 'github',
      unavailableReason: () => 'GITHUB_TOKEN is not set',
      collect: async () => {
        throw new Error('collect() must not be called on an unavailable collector');
      },
    };

    const result = await collect([unconfigured]);

    expect(result.runs[0]?.status).toBe('skipped');
    expect(result.runs[0]?.skippedReason).toBe('GITHUB_TOKEN is not set');
  });

  test('materializes relations into edges between the nodes they address', async () => {
    const result = await collect([relatingCollector('pagerduty')]);

    const deploy = result.nodes.find((node) => node.kind === 'deployment');
    const alert = result.nodes.find((node) => node.kind === 'alert');

    expect(deploy).toBeDefined();
    expect(alert).toBeDefined();
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.from).toBe(deploy?.id);
    expect(result.edges[0]?.to).toBe(alert?.id);
    expect(result.edges[0]?.relation).toBe('PRECEDED');
  });

  test('drops a relation addressing evidence nobody collected', async () => {
    const dangling: Collector = {
      name: 'github',
      collect: async () => ({
        evidence: [{ kind: 'deployment', version: 1, payload: deployPayload }],
        // The alert lives in PagerDuty, and PagerDuty is not in this run.
        relations: [
          {
            from: evidenceKey('deployment', 1, 'payments-api:production:v2.4.1'),
            to: evidenceKey('alert', 1, 'pagerduty:INC-481'),
            relation: 'PRECEDED',
          },
        ],
      }),
    };

    const result = await collect([dangling]);

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
  });

  test('produces a graph that builds without dangling edges when a collector fails', async () => {
    const exploding: Collector = {
      name: 'datadog',
      collect: async () => {
        throw new Error('502 from Datadog');
      },
    };
    const target = investigation();

    const result = await collectEvidence({
      collectors: [exploding, relatingCollector('pagerduty')],
      investigation: target,
      registry: registry(),
      clock: steppingClock(ALERT_AT),
    });
    const graph = buildEvidenceGraph({
      investigationId: target.id,
      nodes: result.nodes,
      edges: result.edges,
    });

    expect(graph.nodes).toHaveLength(2);
    expect(missingInformationFrom(result.runs)).toEqual(['datadog failed: 502 from Datadog']);
  });

  test('runs collectors concurrently rather than one after another', async () => {
    const running = new Set<string>();
    let maxConcurrent = 0;

    const slow = (name: string): Collector => ({
      name,
      collect: async () => {
        running.add(name);
        maxConcurrent = Math.max(maxConcurrent, running.size);
        await Bun.sleep(20);
        running.delete(name);
        return { evidence: [] };
      },
    });

    await collect([slow('github'), slow('datadog'), slow('pagerduty')]);

    expect(maxConcurrent).toBe(3);
  });

  test('fails only the collector whose payload does not match its schema', async () => {
    const malformed = stubCollector('datadog', [
      { kind: 'deployment', payload: { service: 'payments-api' } },
    ]);

    const result = await collect([
      malformed,
      stubCollector('github', [{ kind: 'deployment', payload: deployPayload }]),
    ]);

    expect(result.nodes).toHaveLength(1);
    expect(result.runs.find((run) => run.collector === 'datadog')?.status).toBe('failed');
  });

  test('records the same evidence found by two collectors once', async () => {
    const drafts = [{ kind: 'deployment', payload: deployPayload }];
    const result = await collect([
      stubCollector('github', drafts),
      stubCollector('datadog', drafts),
    ]);

    expect(result.nodes).toHaveLength(1);
    // Both genuinely reported it, so neither run looks like an empty blind spot.
    expect(result.runs.map((run) => run.nodeCount)).toEqual([1, 1]);
  });

  test('resolves duplicate evidence to the same node whatever order collectors finish in', async () => {
    const drafts = [{ kind: 'deployment', payload: deployPayload }];
    const fast = stubCollector('datadog', drafts);
    const slow: Collector = {
      name: 'github',
      collect: async () => {
        await Bun.sleep(10);
        return { evidence: drafts.map((d) => ({ kind: d.kind, version: 1, payload: d.payload })) };
      },
    };

    const slowFirst = await collect([slow, fast]);
    const fastFirst = await collect([fast, slow]);

    // Deterministic by collector name, not by whichever HTTP call came back first.
    expect(slowFirst.nodes[0]?.connector).toBe('datadog');
    expect(fastFirst.nodes[0]?.connector).toBe('datadog');
  });

  test('fails a collector that outlives its deadline instead of hanging the investigation', async () => {
    const wedged: Collector = {
      name: 'datadog',
      collect: () => new Promise<never>(() => {}),
    };
    const target = investigation();

    const result = await collectEvidence({
      collectors: [
        wedged,
        stubCollector('github', [{ kind: 'deployment', payload: deployPayload }]),
      ],
      investigation: target,
      registry: registry(),
      clock: steppingClock(ALERT_AT),
      timeoutMs: 20,
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.runs.find((run) => run.collector === 'datadog')?.error).toBe(
      'did not respond within 20ms',
    );
  });
});
