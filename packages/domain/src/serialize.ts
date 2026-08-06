import type { EvidenceNode } from './entities/evidence.ts';
import type { EvidenceGraph } from './graph.ts';
import type { EvidenceNodeId } from './ids.ts';
import type { EvidenceKindRegistry } from './registry.ts';

/**
 * Turning an evidence graph into prompt text.
 *
 * This lives in the domain package because it is a *contract*, not an implementation detail. Three
 * things depend on it holding:
 *
 *  - **Determinism.** The same graph must produce byte-identical text. Otherwise "why did the model
 *    say that?" is unanswerable six months later, and prompt caching cannot work.
 *  - **Addressability.** Every node gets a short id (`E1`, `E7`) the model can cite and the
 *    citation validator can resolve. A cited id that does not appear here is a hallucination, and
 *    that check is what actually stops the AI guessing — not prompt wording.
 *  - **Honest elision.** When evidence is dropped for length, the text says so. Silently truncating
 *    would leave the model confident about evidence it never saw.
 */

export interface SerializeOptions {
  /**
   * Approximate size limit, in characters.
   *
   * Characters rather than tokens so the domain package stays free of any tokenizer dependency.
   * Roughly four characters per token is close enough for budgeting, and the default is
   * deliberately generous — Gemini Flash has a 1M-token context, so the binding constraint here is
   * cost and reasoning quality rather than the window itself.
   */
  budgetChars?: number;
}

const DEFAULT_BUDGET_CHARS = 60_000;

export interface SerializedEvidence {
  text: string;
  /** Short id (`E1`) → node id. The only sanctioned way to resolve a citation. */
  idMap: ReadonlyMap<string, EvidenceNodeId>;
  /** How many nodes were dropped to fit the budget. */
  elided: number;
}

/**
 * Section ordering, which doubles as drop priority.
 *
 * Ordered by what an investigator reaches for first. The alert is the symptom under investigation;
 * changes are the overwhelming cause of production incidents; precedent ("we've seen this before")
 * resolves an investigation faster than any amount of corroborating telemetry, which is why past
 * incidents outrank metrics and logs.
 *
 * Anything not listed — plugin kinds — renders last via its own `summarize()`.
 */
const SECTIONS: readonly { title: string; kinds: readonly string[] }[] = [
  { title: 'Alert', kinds: ['alert'] },
  { title: 'Changes', kinds: ['deployment', 'config_change', 'feature_flag_change'] },
  { title: 'Prior incidents', kinds: ['past_incident'] },
  { title: 'Metrics', kinds: ['metric_series'] },
  { title: 'Logs', kinds: ['log_pattern'] },
  { title: 'Code', kinds: ['pull_request', 'commit'] },
  { title: 'Topology', kinds: ['service'] },
];

const ADDITIONAL_SECTION = 'Additional evidence';

/** The alert is never dropped: an investigation report that omits the symptom is meaningless. */
const NEVER_ELIDE = new Set(['alert']);

function sectionFor(kind: string): string {
  return SECTIONS.find((section) => section.kinds.includes(kind))?.title ?? ADDITIONAL_SECTION;
}

function sectionRank(title: string): number {
  const index = SECTIONS.findIndex((section) => section.title === title);
  return index === -1 ? SECTIONS.length : index;
}

/**
 * Renders one node.
 *
 * `summarize()` comes from the kind definition, so core and plugin kinds are rendered by exactly
 * the same path — a third-party collector is legible to the reasoner on day one without any
 * change here.
 */
function renderNode(node: EvidenceNode, label: string, registry: EvidenceKindRegistry): string {
  const definition = registry.get(node.kind, node.kindVersion);
  const summary = definition ? definition.summarize(node.payload) : `${node.kind} (unrecognised)`;

  const lines = [`[${label}] ${node.occurredAt.toISOString()} — ${summary}`];
  if (node.sourceUrl) lines.push(`      source: ${node.sourceUrl}`);
  // Surfaced only when it actually diverges, since clock skew is the exception, not the rule.
  if (node.observedAt && node.observedAt.getTime() !== node.occurredAt.getTime()) {
    lines.push(`      recorded by source at: ${node.observedAt.toISOString()}`);
  }
  return lines.join('\n');
}

/**
 * Chooses which nodes fit the budget.
 *
 * Walks in priority order rather than timeline order, so a tight budget sheds low-signal noise
 * instead of arbitrarily truncating the end of the timeline. Selection is by *section*, so the
 * result never depends on how nodes happened to interleave in time.
 */
function selectWithinBudget(
  graph: EvidenceGraph,
  registry: EvidenceKindRegistry,
  budgetChars: number,
): { included: readonly EvidenceNode[]; elided: number } {
  const byPriority = [...graph.nodes].sort((a, b) => {
    const rank = sectionRank(sectionFor(a.kind)) - sectionRank(sectionFor(b.kind));
    if (rank !== 0) return rank;
    return a.occurredAt.getTime() - b.occurredAt.getTime();
  });

  const included: EvidenceNode[] = [];
  let used = 0;
  let elided = 0;

  for (const node of byPriority) {
    const cost = renderNode(node, 'E000', registry).length + 1;
    if (NEVER_ELIDE.has(node.kind) || used + cost <= budgetChars) {
      included.push(node);
      used += cost;
    } else {
      elided++;
    }
  }

  return { included, elided };
}

export function serializeForReasoning(
  graph: EvidenceGraph,
  registry: EvidenceKindRegistry,
  options: SerializeOptions = {},
): SerializedEvidence {
  const budgetChars = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const { included, elided } = selectWithinBudget(graph, registry, budgetChars);

  if (included.length === 0) {
    return {
      text: 'No evidence was collected for this investigation.',
      idMap: new Map(),
      elided,
    };
  }

  // Group into sections, preserving the graph's deterministic timeline order within each.
  const includedIds = new Set(included.map((node) => node.id));
  const grouped = new Map<string, EvidenceNode[]>();
  for (const node of graph.nodes) {
    if (!includedIds.has(node.id)) continue;
    const title = sectionFor(node.kind);
    const bucket = grouped.get(title);
    if (bucket) bucket.push(node);
    else grouped.set(title, [node]);
  }

  const orderedTitles = [...grouped.keys()].sort((a, b) => sectionRank(a) - sectionRank(b));

  // Short ids are assigned in reading order, so a citation like [E7] can be found by scanning
  // down rather than searching.
  const idMap = new Map<string, EvidenceNodeId>();
  const labelOf = new Map<EvidenceNodeId, string>();
  const positionOf = new Map<EvidenceNodeId, number>();
  let counter = 0;
  for (const title of orderedTitles) {
    for (const node of grouped.get(title) ?? []) {
      counter++;
      const label = `E${counter}`;
      idMap.set(label, node.id);
      labelOf.set(node.id, label);
      positionOf.set(node.id, counter);
    }
  }

  const parts: string[] = ['# Evidence', ''];

  for (const title of orderedTitles) {
    parts.push(`## ${title}`);
    for (const node of grouped.get(title) ?? []) {
      parts.push(renderNode(node, labelOf.get(node.id) ?? '?', registry));
    }
    parts.push('');
  }

  // Only relations between included nodes; an edge to elided evidence would be uncitable.
  //
  // Ordered by label position rather than by the rendered string, which would sort E11 above E2
  // and leave the relation list out of step with the evidence above it. Sorting on the edge itself
  // (not on collector order) is what keeps the text byte-identical run to run.
  const position = (id: EvidenceNodeId) => positionOf.get(id) ?? Number.MAX_SAFE_INTEGER;
  const relations = graph.edges
    .filter((edge) => labelOf.has(edge.from) && labelOf.has(edge.to))
    .sort(
      (a, b) =>
        position(a.from) - position(b.from) ||
        position(a.to) - position(b.to) ||
        a.relation.localeCompare(b.relation),
    )
    .map((edge) => `${labelOf.get(edge.from)} ${edge.relation} ${labelOf.get(edge.to)}`);

  if (relations.length > 0) {
    parts.push('## Relations', ...relations, '');
  }

  if (elided > 0) {
    parts.push(
      `## Omitted`,
      `${elided} further item(s) of evidence were omitted to fit the context budget. ` +
        'Do not treat this evidence set as exhaustive.',
      '',
    );
  }

  return { text: parts.join('\n').trimEnd(), idMap, elided };
}
