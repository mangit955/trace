import {
  type Clock,
  type CollectorRun,
  completeCollectorRun,
  createEvidenceEdge,
  createEvidenceNode,
  type EvidenceEdge,
  type EvidenceKindRegistry,
  type EvidenceNode,
  failCollectorRun,
  type Investigation,
  skipCollectorRun,
  startCollectorRun,
} from '@trace/domain';
import type { Collector, RelationDraft } from './collector.ts';

/**
 * Runs every collector for an investigation and assembles the result.
 *
 * The two properties this file exists to guarantee:
 *
 *  1. **A partial investigation is a success.** A collector that throws, hangs, returns a malformed
 *     payload or was never configured produces a recorded gap, never a failed investigation. At 3am
 *     a reconstruction with honest blind spots beats an error.
 *  2. **The output does not depend on the network.** Collectors finish in whatever order their
 *     upstream APIs feel like, so everything ordering-sensitive — which duplicate wins, what order
 *     nodes come back in — is decided by collector name and draft position instead.
 */

/** How long a single collector gets before it is abandoned. Generous; it is a backstop, not a SLA. */
export const DEFAULT_COLLECTOR_TIMEOUT_MS = 20_000;

export interface CollectEvidenceInput {
  collectors: readonly Collector[];
  investigation: Investigation;
  registry: EvidenceKindRegistry;
  clock: Clock;
  timeoutMs?: number;
}

export interface CollectionResult {
  nodes: readonly EvidenceNode[];
  edges: readonly EvidenceEdge[];
  /** The record of what was and was not consulted. Feeds `missingInformationFrom`. */
  runs: readonly CollectorRun[];
}

interface CollectorOutcome {
  collector: string;
  run: CollectorRun;
  nodes: readonly EvidenceNode[];
  relations: readonly RelationDraft[];
}

export async function collectEvidence(input: CollectEvidenceInput): Promise<CollectionResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;

  const startedAt = input.clock.now();
  const outcomes = await Promise.all(
    input.collectors.map((collector) => runOne(collector, input, startedAt, timeoutMs)),
  );

  // Everything below is deterministic: collectors are re-sorted by name, so the assembled graph is
  // identical whether GitHub or Datadog answered first.
  const ordered = [...outcomes].sort((a, b) => a.collector.localeCompare(b.collector));

  const byKey = new Map<string, EvidenceNode>();
  for (const outcome of ordered) {
    for (const node of outcome.nodes) {
      // First wins. The same deploy seen by two collectors is one fact, and which copy is kept
      // must not depend on scheduling.
      if (!byKey.has(node.dedupeKey)) byKey.set(node.dedupeKey, node);
    }
  }

  const relations = ordered.flatMap((outcome) => outcome.relations);

  return {
    nodes: [...byKey.values()],
    edges: resolveEdges(input.investigation, byKey, relations),
    runs: ordered.map((outcome) => outcome.run),
  };
}

async function runOne(
  collector: Collector,
  input: CollectEvidenceInput,
  startedAt: Date,
  timeoutMs: number,
): Promise<CollectorOutcome> {
  const { investigation, registry, clock } = input;

  const run = startCollectorRun({
    orgId: investigation.orgId,
    investigationId: investigation.id,
    collector: collector.name,
    now: startedAt,
  });
  const empty = { collector: collector.name, nodes: [], relations: [] };

  const unavailable = collector.unavailableReason?.();
  if (unavailable !== undefined) {
    return { ...empty, run: skipCollectorRun(run, unavailable, clock.now()) };
  }

  try {
    const result = await withTimeout(collector.collect({ investigation }), timeoutMs);

    // Validation lives here, inside the collector's own error boundary, so a collector that
    // returns a payload its kind rejects fails alone rather than poisoning the batch.
    const nodes = result.evidence.map((draft) =>
      createEvidenceNode({
        registry,
        orgId: investigation.orgId,
        investigationId: investigation.id,
        kind: draft.kind,
        kindVersion: draft.version,
        payload: draft.payload,
        connector: collector.name,
        collectorRunId: run.id,
        // One timestamp for the whole pass: `collectedAt` distinguishes collection runs from each
        // other, not collectors within a run, and a per-collector clock read would make the value
        // depend on completion order.
        collectedAt: startedAt,
      }),
    );

    return {
      collector: collector.name,
      // Counted before deduplication: this answers "did this source have anything to say", and a
      // source that independently confirmed a deploy is not a blind spot.
      run: completeCollectorRun(run, nodes.length, clock.now()),
      nodes,
      relations: result.relations ?? [],
    };
  } catch (error) {
    return { ...empty, run: failCollectorRun(run, describeError(error), clock.now()) };
  }
}

/**
 * Abandons a collector that has stopped answering.
 *
 * Without this, a single wedged HTTP call holds the entire investigation open — the worst failure
 * mode available, because the engineer gets nothing at all rather than a partial answer. The
 * collector's promise is left to settle on its own; it can no longer contribute either way.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`did not respond within ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(describeError(error)));
      },
    );
  });
}

/**
 * Turns keyed relations into edges, discarding any whose endpoints are not in the graph.
 *
 * Discarding is the point. A relation routinely addresses evidence a *different* collector was
 * meant to produce, and that collector may have failed or been skipped — so an unresolved endpoint
 * is the normal consequence of a partial investigation, not an error. `buildEvidenceGraph` rejects
 * dangling edges, so filtering here is what keeps one failed collector from taking the graph down.
 */
function resolveEdges(
  investigation: Investigation,
  byKey: ReadonlyMap<string, EvidenceNode>,
  relations: readonly RelationDraft[],
): readonly EvidenceEdge[] {
  const edges: EvidenceEdge[] = [];

  for (const relation of relations) {
    const from = byKey.get(relation.from)?.id;
    const to = byKey.get(relation.to)?.id;
    // `from === to` means a collector emitted a self-relation, which carries no information.
    if (from === undefined || to === undefined || from === to) continue;

    edges.push(
      createEvidenceEdge({
        orgId: investigation.orgId,
        investigationId: investigation.id,
        from,
        to,
        relation: relation.relation,
      }),
    );
  }

  return edges;
}

/**
 * Turns whatever was thrown into a reason a human can act on.
 *
 * Collectors call third-party SDKs, which throw strings, objects and occasionally `undefined`.
 * `failCollectorRun` rejects an empty reason, so an unhelpfully-thrown value must still produce
 * something legible rather than an exception inside the error handler.
 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  const described = String(error).trim();
  return described.length > 0 ? described : 'threw a non-Error value';
}
