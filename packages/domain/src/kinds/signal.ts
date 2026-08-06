import { z } from 'zod';
import { defineEvidenceKind, formatChange, IsoDateTime, ShortText, Title } from './common.ts';

/**
 * The "what broke" family — the symptoms an investigation starts from.
 *
 * These kinds carry the strictest size limits in the codebase. Metrics and logs are effectively
 * unbounded at the source, and the single fastest way to ruin an evidence graph is to let a
 * collector paste a log file into it. The schemas make that structurally impossible rather than
 * relying on collector authors to be careful.
 */

/**
 * Hard cap on datapoints in a single series. Collectors must downsample before the graph.
 *
 * 200 points is enough to show the shape of a change across an incident window at useful
 * resolution, and small enough that a dozen series still fit comfortably in a prompt.
 */
export const MAX_METRIC_POINTS = 200;

export const alertKind = defineEvidenceKind({
  kind: 'alert',
  version: 1,
  schema: z.object({
    source: ShortText,
    externalId: ShortText,
    title: Title,
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    service: ShortText,
    firedAt: IsoDateTime,
    /** When the source system recorded it. Diverges from firedAt under collection lag. */
    recordedAt: IsoDateTime.optional(),
    url: z.url().optional(),
  }),
  examples: [
    {
      source: 'pagerduty',
      externalId: 'INC-481',
      title: 'Elevated 5xx rate on payments-api',
      severity: 'critical' as const,
      service: 'payments-api',
      firedAt: '2026-08-06T10:16:00.000Z',
      url: 'https://acme.pagerduty.com/incidents/INC-481',
    },
  ],
  identity: (p) => `${p.source}:${p.externalId}`,
  summarize: (p) => {
    // Real PagerDuty and Datadog titles usually embed the service already, so appending it
    // unconditionally yields "Elevated 5xx rate on payments-api on payments-api".
    const scope = p.title.includes(p.service) ? '' : ` on ${p.service}`;
    return `[${p.severity}] ${p.title}${scope} (via ${p.source})`;
  },
  timestamps: (p) => ({
    occurredAt: new Date(p.firedAt),
    observedAt: p.recordedAt === undefined ? undefined : new Date(p.recordedAt),
  }),
  sourceUrl: (p) => p.url,
});

export const metricSeriesKind = defineEvidenceKind({
  kind: 'metric_series',
  version: 1,
  schema: z.object({
    service: ShortText,
    metric: ShortText,
    unit: ShortText,
    window: z.object({ from: IsoDateTime, to: IsoDateTime }),
    points: z
      .array(z.object({ t: IsoDateTime, v: z.number() }))
      .min(1)
      .max(MAX_METRIC_POINTS),
    /** Typical value before the incident, when the collector can establish one. */
    baseline: z.number().optional(),
    changePercent: z.number().optional(),
  }),
  examples: [
    {
      service: 'payments-api',
      metric: 'redis.command.timeout_rate',
      unit: 'errors/s',
      window: { from: '2026-08-06T10:00:00.000Z', to: '2026-08-06T10:20:00.000Z' },
      points: [
        { t: '2026-08-06T10:00:00.000Z', v: 0.2 },
        { t: '2026-08-06T10:10:00.000Z', v: 0.3 },
        { t: '2026-08-06T10:14:00.000Z', v: 6.1 },
        { t: '2026-08-06T10:18:00.000Z', v: 12.9 },
      ],
      baseline: 0.25,
      changePercent: 430,
    },
  ],
  identity: (p) => `${p.service}:${p.metric}:${p.window.from}`,
  summarize: (p) => {
    const values = p.points.map((point) => point.v);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const change = p.changePercent === undefined ? '' : ` (${formatChange(p.changePercent)})`;
    const baseline = p.baseline === undefined ? '' : `, baseline ${p.baseline}`;
    return `${p.metric} on ${p.service}: ${low}–${high} ${p.unit}${change}${baseline}`;
  },
  timestamps: (p) => ({ occurredAt: new Date(p.window.from) }),
});

export const logPatternKind = defineEvidenceKind({
  kind: 'log_pattern',
  version: 1,
  schema: z.object({
    service: ShortText,
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug']),
    /** A normalized template with variables stripped, not a raw line. */
    pattern: z.string().min(1).max(500),
    count: z.int().positive(),
    firstSeenAt: IsoDateTime,
    lastSeenAt: IsoDateTime,
    /**
     * One representative message, capped. There is deliberately no field for a list of raw lines —
     * aggregates only, so no collector can dump a log file into the evidence graph.
     */
    sample: z.string().max(1000).optional(),
  }),
  examples: [
    {
      service: 'payments-api',
      level: 'error' as const,
      pattern: 'redis: connection pool exhausted (waited <duration>)',
      count: 4127,
      firstSeenAt: '2026-08-06T10:13:00.000Z',
      lastSeenAt: '2026-08-06T10:19:00.000Z',
      sample: 'redis: connection pool exhausted (waited 5.00s)',
    },
  ],
  identity: (p) => `${p.service}:${p.pattern}`,
  summarize: (p) =>
    `${p.count}× [${p.level}] on ${p.service}: ${p.pattern} ` +
    `(${p.firstSeenAt} → ${p.lastSeenAt})`,
  timestamps: (p) => ({ occurredAt: new Date(p.firstSeenAt) }),
});
