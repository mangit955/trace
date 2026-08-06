import {
  alertKind,
  commitKind,
  configChangeKind,
  deploymentKind,
  type ExternalRef,
  featureFlagChangeKind,
  logPatternKind,
  metricSeriesKind,
  pastIncidentKind,
  pullRequestKind,
  serviceKind,
} from '@trace/domain';
import { type Collector, type CollectorResult, draft, keyOf } from '../collector.ts';

/**
 * INC-481 — the seeded incident the zero-credential demo runs on.
 *
 * A real reconstruction, not lorem ipsum: a cost-tuning change lowers `REDIS_POOL_MAX` from 50 to
 * 5, the deploy carrying it exhausts the connection pool under normal load, payments-api starts
 * timing out, and checkout-web fails behind it. The same thing happened in March (INC-302).
 *
 * Three properties are deliberate, because a reviewer is reading the output:
 *
 *  - **Multi-service.** The alert fires on payments-api, but the damage shows up in checkout-web.
 *    A reconstruction that only follows the alerting service misses the blast radius.
 *  - **A decoy.** A feature flag moved on checkout-web seven minutes before the alert, and had
 *    nothing to do with it. Evidence that all points one way tests nothing.
 *  - **A redacted config change.** A credential rotated in the same deploy, whose values must
 *    never reach the prompt. See `configChangeKind`.
 *
 * Timestamps are absolute rather than relative to now, because the recorded reasoning replayed in
 * the demo has to match the evidence it was captured against, byte for byte.
 */

export interface SeededSource {
  /** Names the system the evidence came from — surfaces verbatim in gap text. */
  readonly name: string;
  readonly result: CollectorResult;
}

export interface SeededIncident {
  readonly externalRef: ExternalRef;
  /** When the alert fired. The investigation window is anchored here. */
  readonly alertAt: Date;
  readonly sources: readonly SeededSource[];
}

const PAYMENTS = 'payments-api';
const CHECKOUT = 'checkout-web';
const REPO = 'acme/payments-api';

// Payloads are declared as named constants so relations can address them through `keyOf`, which
// derives the key from the kind's own identity function — no hand-written keys to drift.

const paymentsAlert = {
  source: 'pagerduty',
  externalId: 'INC-481',
  title: 'Elevated 5xx rate on payments-api',
  severity: 'critical' as const,
  service: PAYMENTS,
  firedAt: '2026-08-06T10:16:00.000Z',
  url: 'https://acme.pagerduty.com/incidents/INC-481',
};

const checkoutAlert = {
  source: 'pagerduty',
  externalId: 'INC-482',
  title: 'Checkout success rate below SLO',
  severity: 'high' as const,
  service: CHECKOUT,
  firedAt: '2026-08-06T10:19:00.000Z',
  // Detected on a five-minute evaluation window, so PagerDuty recorded it well after it began.
  recordedAt: '2026-08-06T10:19:45.000Z',
  url: 'https://acme.pagerduty.com/incidents/INC-482',
};

const poolCommit = {
  repo: REPO,
  sha: '9f2c1ab',
  message: 'Reduce redis pool max from 50 to 5',
  author: 'dmitri',
  committedAt: '2026-08-06T09:41:00.000Z',
  url: 'https://github.com/acme/payments-api/commit/9f2c1ab',
};

const poolPullRequest = {
  repo: REPO,
  number: 1893,
  title: 'Tune Redis connection pool for lower idle cost',
  author: 'dmitri',
  mergedAt: '2026-08-06T09:58:00.000Z',
  additions: 12,
  deletions: 4,
  filesChanged: 2,
  url: 'https://github.com/acme/payments-api/pull/1893',
};

const paymentsDeploy = {
  service: PAYMENTS,
  version: 'v2.4.1',
  environment: 'production',
  status: 'succeeded' as const,
  deployedAt: '2026-08-06T10:12:00.000Z',
  deployedBy: 'ci-bot',
  previousVersion: 'v2.4.0',
  url: 'https://github.com/acme/payments-api/deployments/4821',
};

const poolConfigChange = {
  service: PAYMENTS,
  key: 'REDIS_POOL_MAX',
  previousValue: '50',
  newValue: '5',
  redacted: false,
  changedAt: '2026-08-06T10:12:00.000Z',
  changedBy: 'ci-bot',
  source: 'helm',
};

/** Rotated in the same release. Present to prove credential values never reach the prompt. */
const credentialRotation = {
  service: PAYMENTS,
  key: 'REDIS_AUTH_TOKEN',
  redacted: true,
  changedAt: '2026-08-06T10:12:00.000Z',
  changedBy: 'vault-sync',
  source: 'vault',
};

/** The decoy: a real change in the window that had nothing to do with the incident. */
const cartFlagChange = {
  flag: 'new-cart-ui',
  service: CHECKOUT,
  previousState: 'off' as const,
  newState: 'partial' as const,
  rolloutPercent: 25,
  changedAt: '2026-08-06T10:05:00.000Z',
  changedBy: 'priya',
};

const redisTimeoutMetric = {
  service: PAYMENTS,
  metric: 'redis.command.timeout_rate',
  unit: 'errors/s',
  window: { from: '2026-08-06T10:00:00.000Z', to: '2026-08-06T10:20:00.000Z' },
  points: [
    { t: '2026-08-06T10:00:00.000Z', v: 0.2 },
    { t: '2026-08-06T10:05:00.000Z', v: 0.3 },
    { t: '2026-08-06T10:10:00.000Z', v: 0.2 },
    { t: '2026-08-06T10:13:00.000Z', v: 4.4 },
    { t: '2026-08-06T10:16:00.000Z', v: 11.7 },
    { t: '2026-08-06T10:19:00.000Z', v: 12.9 },
  ],
  baseline: 0.25,
  changePercent: 5060,
};

const paymentsErrorRateMetric = {
  service: PAYMENTS,
  metric: 'http.server.5xx_rate',
  unit: 'errors/s',
  window: { from: '2026-08-06T10:00:00.000Z', to: '2026-08-06T10:20:00.000Z' },
  points: [
    { t: '2026-08-06T10:00:00.000Z', v: 0.1 },
    { t: '2026-08-06T10:10:00.000Z', v: 0.1 },
    { t: '2026-08-06T10:14:00.000Z', v: 3.8 },
    { t: '2026-08-06T10:16:00.000Z', v: 9.2 },
    { t: '2026-08-06T10:19:00.000Z', v: 10.4 },
  ],
  baseline: 0.12,
  changePercent: 8567,
};

const checkoutSuccessMetric = {
  service: CHECKOUT,
  metric: 'checkout.success_rate',
  unit: '%',
  window: { from: '2026-08-06T10:10:00.000Z', to: '2026-08-06T10:30:00.000Z' },
  points: [
    { t: '2026-08-06T10:10:00.000Z', v: 99.1 },
    { t: '2026-08-06T10:15:00.000Z', v: 97.4 },
    { t: '2026-08-06T10:18:00.000Z', v: 71.2 },
    { t: '2026-08-06T10:22:00.000Z', v: 63.8 },
  ],
  baseline: 99.2,
  changePercent: -36,
};

const poolExhaustedLogs = {
  service: PAYMENTS,
  level: 'error' as const,
  pattern: 'redis: connection pool exhausted (waited <duration>)',
  count: 4127,
  firstSeenAt: '2026-08-06T10:13:00.000Z',
  lastSeenAt: '2026-08-06T10:19:00.000Z',
  sample: 'redis: connection pool exhausted (waited 5.00s)',
};

const checkoutUpstreamLogs = {
  service: CHECKOUT,
  level: 'error' as const,
  // The upstream's name is the finding, not a variable to template away — normalising it out
  // would hide the one thing that connects checkout-web's failure to payments-api.
  pattern: 'upstream payments-api returned 503 after <duration>',
  count: 812,
  firstSeenAt: '2026-08-06T10:17:00.000Z',
  lastSeenAt: '2026-08-06T10:22:00.000Z',
  sample: 'upstream payments-api returned 503 after 5.01s',
};

const SNAPSHOT_AT = '2026-08-06T10:16:00.000Z';

const paymentsService = {
  name: PAYMENTS,
  tier: 'tier1' as const,
  owner: 'payments-team',
  repo: 'https://github.com/acme/payments-api',
  dependsOn: ['redis-primary', 'postgres-payments', 'ledger-service'],
  snapshotAt: SNAPSHOT_AT,
};

const checkoutService = {
  name: CHECKOUT,
  tier: 'tier1' as const,
  owner: 'storefront-team',
  repo: 'https://github.com/acme/checkout-web',
  dependsOn: [PAYMENTS, 'catalog-service'],
  snapshotAt: SNAPSHOT_AT,
};

const redisService = {
  name: 'redis-primary',
  tier: 'tier1' as const,
  owner: 'platform-team',
  dependsOn: [],
  snapshotAt: SNAPSHOT_AT,
};

const priorPoolIncident = {
  externalId: 'INC-302',
  title: 'Redis connection pool exhaustion on payments-api',
  occurredAt: '2026-03-14T02:41:00.000Z',
  resolvedAt: '2026-03-14T03:20:00.000Z',
  rootCause: 'Pool max lowered below steady-state concurrency during a cost-tuning change.',
  fixSummary: 'Reverted REDIS_POOL_MAX to 50 and added a pool saturation alert.',
  affectedServices: [PAYMENTS],
  similarity: 0.91,
  url: 'https://acme.pagerduty.com/incidents/INC-302',
};

export const INC_481: SeededIncident = {
  externalRef: { system: 'pagerduty', id: 'INC-481' },
  alertAt: new Date(paymentsAlert.firedAt),
  sources: [
    {
      name: 'pagerduty',
      result: {
        evidence: [draft(alertKind, paymentsAlert), draft(alertKind, checkoutAlert)],
        relations: [
          {
            from: keyOf(alertKind, paymentsAlert),
            to: keyOf(serviceKind, paymentsService),
            relation: 'EMITTED_BY',
          },
          {
            from: keyOf(alertKind, checkoutAlert),
            to: keyOf(serviceKind, checkoutService),
            relation: 'EMITTED_BY',
          },
        ],
      },
    },
    {
      name: 'github',
      result: {
        evidence: [
          draft(commitKind, poolCommit),
          draft(pullRequestKind, poolPullRequest),
          draft(deploymentKind, paymentsDeploy),
        ],
        relations: [
          {
            from: keyOf(commitKind, poolCommit),
            to: keyOf(pullRequestKind, poolPullRequest),
            relation: 'PART_OF',
          },
          {
            from: keyOf(deploymentKind, paymentsDeploy),
            to: keyOf(pullRequestKind, poolPullRequest),
            relation: 'INTRODUCED_BY',
          },
          {
            from: keyOf(deploymentKind, paymentsDeploy),
            to: keyOf(serviceKind, paymentsService),
            relation: 'DEPLOYED_TO',
          },
          // Ordering, stated as fact. Whether the deploy *caused* the alert is a claim, and claims
          // belong in a hypothesis that cites this edge.
          {
            from: keyOf(deploymentKind, paymentsDeploy),
            to: keyOf(alertKind, paymentsAlert),
            relation: 'PRECEDED',
          },
        ],
      },
    },
    {
      name: 'config',
      result: {
        evidence: [
          draft(configChangeKind, poolConfigChange),
          draft(configChangeKind, credentialRotation),
          draft(featureFlagChangeKind, cartFlagChange),
        ],
        relations: [
          // Addresses evidence the GitHub collector produces. If GitHub is unavailable the edge is
          // dropped and the config change stands alone, rather than dangling.
          {
            from: keyOf(configChangeKind, poolConfigChange),
            to: keyOf(deploymentKind, paymentsDeploy),
            relation: 'INTRODUCED_BY',
          },
        ],
      },
    },
    {
      name: 'datadog',
      result: {
        evidence: [
          draft(metricSeriesKind, redisTimeoutMetric),
          draft(metricSeriesKind, paymentsErrorRateMetric),
          draft(metricSeriesKind, checkoutSuccessMetric),
        ],
        relations: [
          {
            from: keyOf(metricSeriesKind, redisTimeoutMetric),
            to: keyOf(serviceKind, paymentsService),
            relation: 'EMITTED_BY',
          },
          {
            from: keyOf(metricSeriesKind, paymentsErrorRateMetric),
            to: keyOf(serviceKind, paymentsService),
            relation: 'EMITTED_BY',
          },
          {
            from: keyOf(metricSeriesKind, checkoutSuccessMetric),
            to: keyOf(serviceKind, checkoutService),
            relation: 'EMITTED_BY',
          },
        ],
      },
    },
    {
      name: 'logs',
      result: {
        evidence: [
          draft(logPatternKind, poolExhaustedLogs),
          draft(logPatternKind, checkoutUpstreamLogs),
        ],
        relations: [
          {
            from: keyOf(logPatternKind, poolExhaustedLogs),
            to: keyOf(serviceKind, paymentsService),
            relation: 'EMITTED_BY',
          },
          {
            from: keyOf(logPatternKind, checkoutUpstreamLogs),
            to: keyOf(serviceKind, checkoutService),
            relation: 'EMITTED_BY',
          },
          {
            from: keyOf(deploymentKind, paymentsDeploy),
            to: keyOf(logPatternKind, poolExhaustedLogs),
            relation: 'PRECEDED',
          },
        ],
      },
    },
    {
      name: 'service-catalog',
      result: {
        evidence: [
          draft(serviceKind, paymentsService),
          draft(serviceKind, checkoutService),
          draft(serviceKind, redisService),
        ],
      },
    },
    {
      name: 'incident-history',
      result: {
        evidence: [draft(pastIncidentKind, priorPoolIncident)],
        relations: [
          {
            from: keyOf(pastIncidentKind, priorPoolIncident),
            to: keyOf(alertKind, paymentsAlert),
            relation: 'SIMILAR_TO',
          },
        ],
      },
    },
  ],
};

/**
 * Turns a seeded incident into collectors.
 *
 * One collector per source rather than one returning everything, so the demo exercises the real
 * parallel runner — and so breaking a single source in the README's failure walkthrough produces a
 * genuine, partial investigation rather than an empty one.
 */
export function fixtureCollectors(incident: SeededIncident): readonly Collector[] {
  return incident.sources.map((source) => ({
    name: source.name,
    collect: async () => source.result,
  }));
}
