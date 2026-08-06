import type { EvidenceEdge, EvidenceNode } from './entities/evidence.ts';
import type { EvidenceNodeId, InvestigationId } from './ids.ts';

/**
 * The evidence graph for a single investigation.
 *
 * Deliberately a plain, immutable value rather than a mutable object with an API. It is built once
 * from collector output, validated, and then only read — by the serializer, the renderer and the
 * citation validator. Nothing downstream should be able to add evidence after the fact, because a
 * report is only reproducible if the graph it was generated from cannot change underneath it.
 *
 * Graphs stay small (hundreds of nodes, one investigation) and traversals shallow, which is why
 * this is an in-memory value and Postgres is enough for storage — a graph database would add a
 * second consistency domain and a second thing to operate for no benefit at this scale.
 */
export interface EvidenceGraph {
  readonly investigationId: InvestigationId;
  /** Deduplicated and deterministically ordered. See {@link buildEvidenceGraph}. */
  readonly nodes: readonly EvidenceNode[];
  readonly edges: readonly EvidenceEdge[];
}

export interface BuildEvidenceGraphInput {
  investigationId: InvestigationId;
  nodes: readonly EvidenceNode[];
  edges: readonly EvidenceEdge[];
}

/**
 * Orders evidence by when the event happened, then deterministically.
 *
 * `occurredAt` rather than `collectedAt`, because the whole product is a timeline and collection
 * lag varies wildly between sources — ordering by fetch time would routinely show a deploy after
 * the errors it caused.
 *
 * The `kind` and `id` tiebreakers are what make prompt text byte-identical across runs for the
 * same evidence, which in turn buys prompt caching and reproducible reports. Shared timestamps are
 * common in practice: a deploy and the config change that shipped with it.
 */
function compareNodes(a: EvidenceNode, b: EvidenceNode): number {
  const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (byTime !== 0) return byTime;

  const byKind = a.kind.localeCompare(b.kind);
  if (byKind !== 0) return byKind;

  return a.id.localeCompare(b.id);
}

/**
 * Picks the winner when the same logical evidence was collected more than once.
 *
 * Earliest observation wins, with the id as a tiebreak so the choice does not depend on the order
 * collectors happened to finish in.
 */
function preferEarlier(a: EvidenceNode, b: EvidenceNode): EvidenceNode {
  const byCollected = a.collectedAt.getTime() - b.collectedAt.getTime();
  if (byCollected !== 0) return byCollected < 0 ? a : b;
  return a.id.localeCompare(b.id) <= 0 ? a : b;
}

/**
 * Validates and normalises collector output into a graph.
 *
 * Throws rather than silently dropping bad input: a dangling edge or a node from another
 * investigation means a collector is buggy, and quietly discarding evidence would make the
 * resulting report subtly wrong in a way nobody would notice.
 */
export function buildEvidenceGraph(input: BuildEvidenceGraphInput): EvidenceGraph {
  const { investigationId } = input;

  for (const node of input.nodes) {
    if (node.investigationId !== investigationId) {
      throw new Error(
        `Evidence node ${node.id} belongs to investigation ${node.investigationId}, ` +
          `not ${investigationId}.`,
      );
    }
  }

  // Deduplicate on logical identity, not node id — the same deploy collected twice is one fact.
  const byDedupeKey = new Map<string, EvidenceNode>();
  for (const node of input.nodes) {
    const existing = byDedupeKey.get(node.dedupeKey);
    byDedupeKey.set(node.dedupeKey, existing ? preferEarlier(existing, node) : node);
  }

  const nodes = [...byDedupeKey.values()].sort(compareNodes);
  const present = new Set(nodes.map((node) => node.id));

  for (const edge of input.edges) {
    if (edge.investigationId !== investigationId) {
      throw new Error(
        `Evidence edge ${edge.from}→${edge.to} belongs to investigation ` +
          `${edge.investigationId}, not ${investigationId}.`,
      );
    }
    if (!present.has(edge.from) || !present.has(edge.to)) {
      const missing = present.has(edge.from) ? edge.to : edge.from;
      throw new Error(
        `Dangling evidence edge ${edge.from}→${edge.to} (${edge.relation}): ` +
          `node ${missing} is not in the graph.`,
      );
    }
  }

  return { investigationId, nodes, edges: [...input.edges] };
}

export function nodesOfKind(graph: EvidenceGraph, kind: string): readonly EvidenceNode[] {
  return graph.nodes.filter((node) => node.kind === kind);
}

/**
 * Nodes directly related to the given one, in either direction.
 *
 * Relations are factual, so direction carries meaning for rendering but not for reachability —
 * "what else do we know about this?" should not depend on which way a collector wrote the edge.
 */
export function neighboursOf(
  graph: EvidenceGraph,
  nodeId: EvidenceNodeId,
): readonly EvidenceNode[] {
  const neighbourIds = new Set<EvidenceNodeId>();
  for (const edge of graph.edges) {
    if (edge.from === nodeId) neighbourIds.add(edge.to);
    if (edge.to === nodeId) neighbourIds.add(edge.from);
  }
  return graph.nodes.filter((node) => neighbourIds.has(node.id));
}
