import { z } from 'zod';
import { defineEvidenceKind, IsoDateTime, ShortText, Title } from './common.ts';

/**
 * The "background" family — evidence that is not itself an event.
 *
 * Both kinds describe state rather than a moment, so their `occurredAt` is the time the state was
 * observed or the time the referenced incident happened. Keeping them in the graph (rather than
 * passing them separately) means the reasoner can cite topology and precedent the same way it
 * cites a deploy.
 */

export const serviceKind = defineEvidenceKind({
  kind: 'service',
  version: 1,
  schema: z.object({
    name: ShortText,
    tier: z.enum(['tier1', 'tier2', 'tier3']).optional(),
    owner: ShortText.optional(),
    repo: z.url().optional(),
    dependsOn: z.array(ShortText).max(50).default([]),
    /** When this topology snapshot was taken — topology drifts, so evidence must be dated. */
    snapshotAt: IsoDateTime,
  }),
  examples: [
    {
      name: 'payments-api',
      tier: 'tier1' as const,
      owner: 'payments-team',
      repo: 'https://github.com/acme/payments-api',
      dependsOn: ['redis-primary', 'postgres-payments', 'ledger-service'],
      snapshotAt: '2026-08-06T10:16:00.000Z',
    },
  ],
  identity: (p) => p.name,
  summarize: (p) => {
    const tier = p.tier ? ` (${p.tier})` : '';
    const owner = p.owner ? `, owned by ${p.owner}` : '';
    const deps = p.dependsOn.length > 0 ? `; depends on ${p.dependsOn.join(', ')}` : '';
    return `Service ${p.name}${tier}${owner}${deps}`;
  },
  timestamps: (p) => ({ occurredAt: new Date(p.snapshotAt) }),
  sourceUrl: (p) => p.repo,
});

export const pastIncidentKind = defineEvidenceKind({
  kind: 'past_incident',
  version: 1,
  schema: z.object({
    externalId: ShortText,
    title: Title,
    occurredAt: IsoDateTime,
    resolvedAt: IsoDateTime.optional(),
    rootCause: z.string().max(1000).optional(),
    fixSummary: z.string().max(1000).optional(),
    affectedServices: z.array(ShortText).max(50).default([]),
    /** Similarity to the incident under investigation, 0–1, from the history collector. */
    similarity: z.number().min(0).max(1).optional(),
    url: z.url().optional(),
  }),
  examples: [
    {
      externalId: 'INC-302',
      title: 'Redis connection pool exhaustion on payments-api',
      occurredAt: '2026-03-14T02:41:00.000Z',
      resolvedAt: '2026-03-14T03:20:00.000Z',
      rootCause: 'Pool max lowered below steady-state concurrency during a cost-tuning change.',
      fixSummary: 'Reverted REDIS_POOL_MAX to 50 and added a pool saturation alert.',
      affectedServices: ['payments-api'],
      similarity: 0.91,
      url: 'https://acme.pagerduty.com/incidents/INC-302',
    },
  ],
  identity: (p) => p.externalId,
  summarize: (p) => {
    const similarity =
      p.similarity === undefined ? '' : ` (${Math.round(p.similarity * 100)}% similar)`;
    const cause = p.rootCause ? ` Root cause: ${p.rootCause}` : '';
    const fix = p.fixSummary ? ` Fix: ${p.fixSummary}` : '';
    return `Past incident ${p.externalId} "${p.title}"${similarity}.${cause}${fix}`;
  },
  timestamps: (p) => ({ occurredAt: new Date(p.occurredAt) }),
  sourceUrl: (p) => p.url,
});
