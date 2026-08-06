import { z } from 'zod';
import { CollectorRunId, EvidenceNodeId, InvestigationId, newId, OrgId } from '../ids.ts';
import type { EvidenceKindRegistry } from '../registry.ts';

/**
 * Evidence nodes and edges — what Trace observed, and how those observations relate.
 *
 * Nodes are immutable and append-only. A citation made against a node must resolve to the same
 * content forever, otherwise "here is the evidence for that conclusion" quietly becomes a lie.
 * Re-collection therefore writes new nodes and relies on `dedupeKey` to avoid duplicates.
 */

/**
 * How two pieces of evidence relate — factually.
 *
 * There is deliberately no `CAUSED_BY`. Causation is a *claim*, and claims belong in Hypothesis
 * where they carry a confidence score and citations that a human can check. Allowing a causal edge
 * here would let the reasoner write its conclusions back into the evidence it reasons over, which
 * is exactly the loop this design exists to prevent.
 */
export const EvidenceRelation = z.enum([
  /** A deployment went to a service or environment. */
  'DEPLOYED_TO',
  /** A change (commit, PR) introduced another artefact. */
  'INTRODUCED_BY',
  /** A service emitted a log pattern, metric or alert. */
  'EMITTED_BY',
  /** Structural containment: a commit is part of a PR, a service part of a system. */
  'PART_OF',
  /** Strict temporal ordering, stated as fact — not as cause. */
  'PRECEDED',
  /** Resemblance to a past incident, from the history collector. */
  'SIMILAR_TO',
]);
export type EvidenceRelation = z.infer<typeof EvidenceRelation>;

export const EvidenceNode = z.object({
  id: EvidenceNodeId,
  orgId: OrgId,
  investigationId: InvestigationId,

  kind: z.string(),
  kindVersion: z.int().positive(),
  payload: z.unknown(),
  /** `kind@version:identity` — the logical identity used to avoid duplicate evidence. */
  dedupeKey: z.string(),

  // Provenance. Human verification is a product promise, so every node must be traceable back
  // to the system it came from and, where possible, to a URL someone can open.
  connector: z.string(),
  collectorRunId: CollectorRunId,
  sourceUrl: z.string().optional(),

  // Three clocks, because they genuinely disagree in production.
  /** When the real-world event happened. */
  occurredAt: z.date(),
  /** When the source system recorded it. Diverges under collection lag. */
  observedAt: z.date().optional(),
  /** When Trace fetched it. */
  collectedAt: z.date(),
});
export type EvidenceNode = z.infer<typeof EvidenceNode>;

export const EvidenceEdge = z.object({
  orgId: OrgId,
  investigationId: InvestigationId,
  from: EvidenceNodeId,
  to: EvidenceNodeId,
  relation: EvidenceRelation,
});
export type EvidenceEdge = z.infer<typeof EvidenceEdge>;

export interface CreateEvidenceNodeInput {
  registry: EvidenceKindRegistry;
  orgId: OrgId;
  investigationId: InvestigationId;
  kind: string;
  kindVersion: number;
  /** Raw, untrusted collector output. Validated here, never before. */
  payload: unknown;
  connector: string;
  collectorRunId: CollectorRunId;
  collectedAt: Date;
}

/**
 * Builds a validated evidence node.
 *
 * Timestamps and the source URL are derived from the kind definition rather than accepted from the
 * caller. A collector that could set `occurredAt` freely could reorder the timeline, which is the
 * one thing an incident investigation must get right.
 */
export function createEvidenceNode(input: CreateEvidenceNodeInput): EvidenceNode {
  const definition = input.registry.require(input.kind, input.kindVersion);
  const payload = definition.schema.parse(input.payload);

  const times = definition.timestamps(payload);
  const sourceUrl = definition.sourceUrl?.(payload);

  return {
    id: newId(EvidenceNodeId),
    orgId: input.orgId,
    investigationId: input.investigationId,
    kind: input.kind,
    kindVersion: input.kindVersion,
    payload,
    dedupeKey: `${input.kind}@${input.kindVersion}:${definition.identity(payload)}`,
    connector: input.connector,
    collectorRunId: input.collectorRunId,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    occurredAt: times.occurredAt,
    ...(times.observedAt === undefined ? {} : { observedAt: times.observedAt }),
    collectedAt: input.collectedAt,
  };
}

export interface CreateEvidenceEdgeInput {
  orgId: OrgId;
  investigationId: InvestigationId;
  from: EvidenceNodeId;
  to: EvidenceNodeId;
  relation: EvidenceRelation;
}

export function createEvidenceEdge(input: CreateEvidenceEdgeInput): EvidenceEdge {
  if (input.from === input.to) {
    throw new Error(
      `Cannot relate evidence node ${input.from} to itself via ${input.relation}; ` +
        'a self-referential relation carries no information.',
    );
  }
  return {
    orgId: input.orgId,
    investigationId: input.investigationId,
    from: input.from,
    to: input.to,
    relation: input.relation,
  };
}
