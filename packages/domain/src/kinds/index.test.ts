import { describe, expect, test } from 'bun:test';
import { EvidenceKindRegistry } from '../registry.ts';
import { assertValidEvidenceKind } from '../testing/conformance.ts';
import {
  alertKind,
  CORE_KINDS,
  configChangeKind,
  logPatternKind,
  MAX_METRIC_POINTS,
  metricSeriesKind,
  registerCoreKinds,
} from './index.ts';

describe('the core kind set', () => {
  test('covers the ten evidence types an investigation is built from', () => {
    expect(CORE_KINDS.map((k) => k.kind).sort()).toEqual([
      'alert',
      'commit',
      'config_change',
      'deployment',
      'feature_flag_change',
      'log_pattern',
      'metric_series',
      'past_incident',
      'pull_request',
      'service',
    ]);
  });

  test.each(CORE_KINDS.map((k) => [k.kind, k] as const))('%s satisfies the contract', (_n, def) => {
    expect(() => assertValidEvidenceKind(def)).not.toThrow();
  });

  test('every core kind registers without collision', () => {
    const registry = new EvidenceKindRegistry();
    registerCoreKinds(registry);

    expect(registry.list()).toHaveLength(CORE_KINDS.length);
    for (const def of CORE_KINDS) {
      expect(registry.isCore(def.kind)).toBe(true);
    }
  });
});

describe('alert summaries read cleanly', () => {
  const base = {
    source: 'pagerduty',
    externalId: 'INC-481',
    severity: 'critical',
    service: 'payments-api',
    firedAt: '2026-08-06T10:16:00.000Z',
  };

  test('names the affected service when the title omits it', () => {
    const summary = alertKind.summarize(
      alertKind.schema.parse({ ...base, title: 'Elevated 5xx rate' }),
    );
    expect(summary).toContain('payments-api');
  });

  test('does not repeat the service when the title already names it', () => {
    // PagerDuty and Datadog titles usually embed the service, so appending it unconditionally
    // produces "Elevated 5xx rate on payments-api on payments-api" in most real alerts.
    const summary = alertKind.summarize(
      alertKind.schema.parse({ ...base, title: 'Elevated 5xx rate on payments-api' }),
    );
    expect(summary.match(/payments-api/g)).toHaveLength(1);
  });
});

describe('metric_series is bounded', () => {
  const valid = metricSeriesKind.examples[0];

  test('accepts a series at the cap', () => {
    const points = Array.from({ length: MAX_METRIC_POINTS }, (_, i) => ({
      t: new Date(Date.UTC(2026, 7, 6, 10, 0, i)).toISOString(),
      v: i,
    }));
    expect(() => metricSeriesKind.schema.parse({ ...valid, points })).not.toThrow();
  });

  test('rejects a series over the cap', () => {
    // A collector must downsample before it reaches the graph. Without this, one noisy metric
    // could push every other piece of evidence out of the prompt.
    const points = Array.from({ length: MAX_METRIC_POINTS + 1 }, (_, i) => ({
      t: new Date(Date.UTC(2026, 7, 6, 10, 0, i)).toISOString(),
      v: i,
    }));
    expect(() => metricSeriesKind.schema.parse({ ...valid, points })).toThrow();
  });
});

describe('log_pattern cannot carry raw logs', () => {
  const valid = logPatternKind.examples[0];

  test('strips an attempt to smuggle raw log lines through', () => {
    // Invariant: collectors return aggregates, never raw text. There is deliberately no field
    // for this, so the payload shape itself makes log dumping impossible.
    const parsed = logPatternKind.schema.parse({
      ...valid,
      lines: ['secret token abc123', 'another line'],
    });

    expect(parsed).not.toHaveProperty('lines');
  });

  test('caps the single representative sample message', () => {
    expect(() => logPatternKind.schema.parse({ ...valid, sample: 'x'.repeat(1001) })).toThrow();
  });
});

describe('config_change protects secret values', () => {
  const example = configChangeKind.examples.find((e) => e.redacted);

  test('ships an example of a redacted change', () => {
    expect(example).toBeDefined();
  });

  test('omits values from the summary when the change is marked redacted', () => {
    // Config diffs routinely contain credentials. A summary is prompt text bound for a
    // third-party LLM, so a redacted change must never render its values.
    const redacted = {
      service: 'payments-api',
      key: 'DATABASE_PASSWORD',
      previousValue: 'hunter2',
      newValue: 'correct-horse-battery-staple',
      redacted: true,
      changedAt: '2026-08-06T10:00:00.000Z',
      changedBy: 'deploy-bot',
      source: 'helm',
    };

    const summary = configChangeKind.summarize(configChangeKind.schema.parse(redacted));

    expect(summary).not.toContain('hunter2');
    expect(summary).not.toContain('correct-horse-battery-staple');
    expect(summary).toContain('DATABASE_PASSWORD');
  });

  test('shows values for a change that is not sensitive', () => {
    const open = {
      service: 'payments-api',
      key: 'REDIS_POOL_SIZE',
      previousValue: '50',
      newValue: '5',
      redacted: false,
      changedAt: '2026-08-06T10:00:00.000Z',
      changedBy: 'deploy-bot',
      source: 'helm',
    };

    const summary = configChangeKind.summarize(configChangeKind.schema.parse(open));

    expect(summary).toContain('50');
    expect(summary).toContain('5');
  });
});
