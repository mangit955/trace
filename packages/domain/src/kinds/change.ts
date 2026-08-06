import { z } from 'zod';
import { defineEvidenceKind, IsoDateTime, ShortText, Title } from './common.ts';

/**
 * The "what changed" family.
 *
 * Production incidents are overwhelmingly caused by something changing. These five kinds are the
 * evidence an investigator reaches for first, and the reasoner weights them most heavily when they
 * fall inside the incident window.
 */

export const deploymentKind = defineEvidenceKind({
  kind: 'deployment',
  version: 1,
  schema: z.object({
    service: ShortText,
    version: ShortText,
    environment: ShortText,
    status: z.enum(['succeeded', 'failed', 'rolled_back']),
    deployedAt: IsoDateTime,
    deployedBy: ShortText,
    previousVersion: ShortText.optional(),
    url: z.url().optional(),
  }),
  examples: [
    {
      service: 'payments-api',
      version: 'v2.4.1',
      environment: 'production',
      status: 'succeeded' as const,
      deployedAt: '2026-08-06T10:12:00.000Z',
      deployedBy: 'ci-bot',
      previousVersion: 'v2.4.0',
      url: 'https://github.com/acme/payments-api/deployments/4821',
    },
  ],
  identity: (p) => `${p.service}:${p.environment}:${p.version}`,
  summarize: (p) => {
    const from = p.previousVersion ? ` (from ${p.previousVersion})` : '';
    return `Deployed ${p.service} ${p.version}${from} to ${p.environment} by ${p.deployedBy} — ${p.status}`;
  },
  timestamps: (p) => ({ occurredAt: new Date(p.deployedAt) }),
  sourceUrl: (p) => p.url,
});

export const pullRequestKind = defineEvidenceKind({
  kind: 'pull_request',
  version: 1,
  schema: z.object({
    repo: ShortText,
    number: z.int().positive(),
    title: Title,
    author: ShortText,
    mergedAt: IsoDateTime,
    additions: z.int().nonnegative(),
    deletions: z.int().nonnegative(),
    filesChanged: z.int().nonnegative(),
    url: z.url().optional(),
  }),
  examples: [
    {
      repo: 'acme/payments-api',
      number: 1893,
      title: 'Tune Redis connection pool for lower idle cost',
      author: 'dmitri',
      mergedAt: '2026-08-06T09:58:00.000Z',
      additions: 12,
      deletions: 4,
      filesChanged: 2,
      url: 'https://github.com/acme/payments-api/pull/1893',
    },
  ],
  identity: (p) => `${p.repo}#${p.number}`,
  summarize: (p) =>
    `PR ${p.repo}#${p.number} "${p.title}" by ${p.author} — ` +
    `${p.filesChanged} file(s), +${p.additions}/-${p.deletions}`,
  timestamps: (p) => ({ occurredAt: new Date(p.mergedAt) }),
  sourceUrl: (p) => p.url,
});

export const commitKind = defineEvidenceKind({
  kind: 'commit',
  version: 1,
  schema: z.object({
    repo: ShortText,
    sha: z.string().min(7).max(40),
    message: Title,
    author: ShortText,
    committedAt: IsoDateTime,
    url: z.url().optional(),
  }),
  examples: [
    {
      repo: 'acme/payments-api',
      sha: '9f2c1ab',
      message: 'Reduce redis pool max from 50 to 5',
      author: 'dmitri',
      committedAt: '2026-08-06T09:41:00.000Z',
      url: 'https://github.com/acme/payments-api/commit/9f2c1ab',
    },
  ],
  identity: (p) => `${p.repo}@${p.sha}`,
  summarize: (p) => `Commit ${p.sha} by ${p.author}: ${p.message}`,
  timestamps: (p) => ({ occurredAt: new Date(p.committedAt) }),
  sourceUrl: (p) => p.url,
});

export const configChangeKind = defineEvidenceKind({
  kind: 'config_change',
  version: 1,
  schema: z.object({
    service: ShortText,
    key: ShortText,
    previousValue: z.string().max(500).optional(),
    newValue: z.string().max(500).optional(),
    /**
     * Set by the collector when the value may contain a credential. Config diffs routinely carry
     * passwords and tokens, and a summary is prompt text bound for a third-party LLM — so this
     * flag is the difference between useful evidence and a credential leak.
     */
    redacted: z.boolean(),
    changedAt: IsoDateTime,
    changedBy: ShortText,
    source: ShortText,
    url: z.url().optional(),
  }),
  examples: [
    {
      service: 'payments-api',
      key: 'REDIS_POOL_MAX',
      previousValue: '50',
      newValue: '5',
      redacted: false,
      changedAt: '2026-08-06T10:12:00.000Z',
      changedBy: 'ci-bot',
      source: 'helm',
    },
    {
      service: 'payments-api',
      key: 'DATABASE_PASSWORD',
      previousValue: 'redacted',
      newValue: 'redacted',
      redacted: true,
      changedAt: '2026-08-06T10:12:00.000Z',
      changedBy: 'ci-bot',
      source: 'vault',
    },
  ],
  identity: (p) => `${p.service}:${p.key}:${p.changedAt}`,
  summarize: (p) => {
    const head = `Config ${p.key} on ${p.service} changed by ${p.changedBy} via ${p.source}`;
    if (p.redacted) return `${head} (values redacted)`;
    return `${head}: ${p.previousValue ?? '(unset)'} → ${p.newValue ?? '(unset)'}`;
  },
  timestamps: (p) => ({ occurredAt: new Date(p.changedAt) }),
  sourceUrl: (p) => p.url,
});

export const featureFlagChangeKind = defineEvidenceKind({
  kind: 'feature_flag_change',
  version: 1,
  schema: z.object({
    flag: ShortText,
    service: ShortText.optional(),
    previousState: z.enum(['on', 'off', 'partial']),
    newState: z.enum(['on', 'off', 'partial']),
    rolloutPercent: z.number().min(0).max(100).optional(),
    changedAt: IsoDateTime,
    changedBy: ShortText,
    url: z.url().optional(),
  }),
  examples: [
    {
      flag: 'redis-pipelining',
      service: 'payments-api',
      previousState: 'off' as const,
      newState: 'partial' as const,
      rolloutPercent: 25,
      changedAt: '2026-08-06T10:05:00.000Z',
      changedBy: 'dmitri',
    },
  ],
  identity: (p) => `${p.flag}:${p.changedAt}`,
  summarize: (p) => {
    const scope = p.service ? ` on ${p.service}` : '';
    const rollout = p.rolloutPercent === undefined ? '' : ` at ${p.rolloutPercent}%`;
    return `Flag ${p.flag}${scope} ${p.previousState} → ${p.newState}${rollout} by ${p.changedBy}`;
  },
  timestamps: (p) => ({ occurredAt: new Date(p.changedAt) }),
  sourceUrl: (p) => p.url,
});
