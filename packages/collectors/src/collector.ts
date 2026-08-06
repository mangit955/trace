import type { EvidenceKindDefinition, EvidenceRelation, Investigation } from '@trace/domain';

/**
 * What a collector proposes, before Trace validates it and stamps it with provenance.
 *
 * Collectors return structured drafts rather than finished `EvidenceNode`s on purpose. Node
 * identity, timestamps and source URLs are derived from the kind definition — a collector that
 * could set `occurredAt` itself could reorder the timeline, which is the one thing an incident
 * reconstruction has to get right.
 */
export interface EvidenceDraft {
  kind: string;
  version: number;
  /** Untrusted until the runner parses it through the kind's schema. */
  payload: unknown;
}

/**
 * A proposed relation, addressed by *evidence key* rather than by node id.
 *
 * Node ids do not exist until the runner materializes drafts, and a collector routinely needs to
 * relate its findings to evidence another collector produced — the GitHub collector knows the
 * deployment it found preceded `alert@1:pagerduty:INC-481` without ever having seen that alert.
 * Keys are the logical identity, so they are stable across collectors and across runs.
 */
export interface RelationDraft {
  from: string;
  to: string;
  relation: EvidenceRelation;
}

/**
 * The address of a piece of evidence: `kind@version:identity`.
 *
 * Identical to `EvidenceNode.dedupeKey` by construction, which is what lets a relation drafted
 * before collection resolve to a node created after it.
 */
export function evidenceKey(kind: string, version: number, identity: string): string {
  return `${kind}@${version}:${identity}`;
}

/**
 * Drafts evidence against a kind definition the collector has to hand.
 *
 * The wire shape stays stringly-typed so a plugin can emit a kind this codebase has never heard
 * of, but an in-tree collector gets its payload checked against the kind's schema at compile time
 * rather than discovering the mismatch as a failed run.
 */
export function draft<T>(kind: EvidenceKindDefinition<T>, payload: T): EvidenceDraft {
  return { kind: kind.kind, version: kind.version, payload };
}

/** The evidence key of a payload, derived from its kind rather than restated by hand. */
export function keyOf<T>(kind: EvidenceKindDefinition<T>, payload: T): string {
  return evidenceKey(kind.kind, kind.version, kind.identity(payload));
}

export interface CollectorResult {
  evidence: readonly EvidenceDraft[];
  relations?: readonly RelationDraft[];
}

export interface CollectorContext {
  readonly investigation: Investigation;
}

export interface Collector {
  /** Stable identifier. Appears verbatim in gap text ("github failed: …"), so keep it short. */
  readonly name: string;
  /**
   * Why this collector cannot run right now, or `undefined` if it can.
   *
   * Distinct from throwing, because "GITHUB_TOKEN is not set" and "GitHub returned 500" send an
   * operator to two different places. Missing configuration is the normal state of the zero
   * credential demo, not a fault.
   */
  unavailableReason?(): string | undefined;
  collect(ctx: CollectorContext): Promise<CollectorResult>;
}
