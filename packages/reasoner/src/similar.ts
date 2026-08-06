import type { EvidenceGraph, EvidenceKindRegistry } from '@trace/domain';
import type { InvestigationReport } from './report.ts';

/**
 * The text an investigation is embedded from.
 *
 * Three parts, in this order: the services involved, the error signature, and the summary. Chosen
 * because they are what an engineer actually matches on — "the payments-api pool thing" — and
 * because each is available for every investigation, including one whose reasoning failed.
 *
 * Deliberately *not* the whole evidence graph. Embedding everything would drown the signal in
 * commit messages and deploy metadata, and two unrelated incidents would look similar for having
 * both deployed something on a Tuesday.
 *
 * Deterministic, for the same reason `serialize.ts` is: the same investigation must produce the
 * same point in space every time, or re-indexing quietly moves incidents around and "have we seen
 * this before" answers differently on Tuesday than it did on Monday.
 */

/** Kinds that name a service worth matching on. Ordered scan, so output does not depend on the map. */
const SERVICE_FIELDS = ['service', 'name'] as const;

export interface SimilaritySourceInput {
  graph: EvidenceGraph;
  registry: EvidenceKindRegistry;
  /** Absent when reasoning failed. The services and signature alone still make a usable vector. */
  report?: InvestigationReport | undefined;
}

export function similaritySourceText(input: SimilaritySourceInput): string {
  const services = new Set<string>();
  const signatures: string[] = [];

  for (const node of input.graph.nodes) {
    const payload = node.payload as Record<string, unknown>;

    for (const field of SERVICE_FIELDS) {
      const value = payload[field];
      if (typeof value === 'string' && value.length > 0) services.add(value);
    }

    // The error signature: what the alert and the log patterns say broke. `summarize` is used
    // rather than raw payload fields so a plugin kind contributes on the same terms as a core one.
    if (node.kind === 'alert' || node.kind === 'log_pattern') {
      const definition = input.registry.get(node.kind, node.kindVersion);
      if (definition) signatures.push(definition.summarize(payload));
    }
  }

  return [
    // Sorted, not insertion-ordered: the graph is already deterministic, but a Set built from it
    // would still reorder if collectors changed, and that would move the vector for no real change.
    [...services].sort().join(' '),
    [...signatures].sort().join(' '),
    input.report?.summary ?? '',
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n');
}
