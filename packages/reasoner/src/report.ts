import {
  type CollectorRun,
  createHypothesis,
  type EvidenceGraph,
  type EvidenceKindRegistry,
  type Hypothesis,
  type Investigation,
  type InvestigationId,
  missingInformationFrom,
  type OrgId,
  type SerializeOptions,
  serializeForReasoning,
} from '@trace/domain';
import { PROMPT_VERSION } from './prompt.ts';
import { MalformedReasoningError, ReasonedOutput, type Reasoner } from './reasoner.ts';

/**
 * Producing an investigation report.
 *
 * This file is where the product's central guarantee is enforced, and it is enforced by
 * construction rather than by inspection: a hypothesis is built with `createHypothesis`, which
 * cannot be called without resolving every citation against the evidence the model was actually
 * shown. An unsupported conclusion is therefore unrepresentable rather than merely discouraged.
 *
 * The division of labour is the design:
 *
 *  - the model writes the summary, the hypotheses and the questions worth asking next;
 *  - the timeline is read off the evidence graph, which is already ordered by `occurredAt`;
 *  - the blind spots come from collector runs.
 *
 * The last two are computed because a model cannot introspect what it was never shown. Asked for
 * gaps it produces a plausible, wrong list, and a wrong list of blind spots is worse than none —
 * it is the part of a report an on-call engineer has no way to check.
 */

export interface TimelineEntry {
  /** The citation label, so a reader can find the evidence this line came from. */
  label: string;
  at: Date;
  kind: string;
  summary: string;
  sourceUrl?: string;
}

export interface InvestigationReport {
  investigationId: InvestigationId;
  orgId: OrgId;
  /** Model prose. Cites evidence labels inline. */
  summary: string;
  hypotheses: readonly Hypothesis[];
  /** Computed from the evidence graph. */
  timeline: readonly TimelineEntry[];
  /** Computed from collector runs. Never model output. */
  missingInformation: readonly string[];
  suggestedQuestions: readonly string[];
  model: string;
  promptVersion: string;
  generatedAt: Date;
}

export interface ReasonAboutInvestigationInput {
  investigation: Investigation;
  graph: EvidenceGraph;
  registry: EvidenceKindRegistry;
  runs: readonly CollectorRun[];
  reasoner: Reasoner;
  now: Date;
  serialize?: SerializeOptions;
}

export async function reasonAboutInvestigation(
  input: ReasonAboutInvestigationInput,
): Promise<InvestigationReport> {
  const { investigation, graph, registry, runs, reasoner, now } = input;

  const evidence = serializeForReasoning(graph, registry, input.serialize ?? {});
  const gaps = missingInformationFrom(runs);

  const raw = await reasoner.reason({ investigation, evidence, gaps });

  // Model output is untrusted input, exactly like collector output. Parsing it here means a
  // truncated or malformed response becomes a typed failure the fallback can act on.
  const parsed = ReasonedOutput.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedReasoningError(reasoner.name, parsed.error.issues[0]?.message ?? 'unknown');
  }

  const evidenceSeen = [...evidence.idMap.values()];

  // Throws HallucinatedCitationError or UngroundedClaimError, which the caller treats as a failed
  // response rather than a partial one. A report is a single claim about what happened; shipping
  // the hypotheses that happened to survive would misrepresent the ones that did not.
  const hypotheses = parsed.data.hypotheses.map((draft) =>
    createHypothesis({
      orgId: investigation.orgId,
      investigationId: investigation.id,
      statement: draft.statement,
      confidence: draft.confidence,
      citations: draft.citations,
      idMap: evidence.idMap,
      model: reasoner.model,
      promptVersion: PROMPT_VERSION,
      evidenceSeen,
      now,
    }),
  );

  return {
    investigationId: investigation.id,
    orgId: investigation.orgId,
    summary: parsed.data.summary,
    hypotheses,
    timeline: timelineFrom(graph, registry, evidence.idMap),
    missingInformation: gaps,
    suggestedQuestions: parsed.data.suggestedQuestions,
    model: reasoner.model,
    promptVersion: PROMPT_VERSION,
    generatedAt: now,
  };
}

export interface UnreasonedReportInput {
  investigation: Investigation;
  graph: EvidenceGraph;
  registry: EvidenceKindRegistry;
  runs: readonly CollectorRun[];
  /** The model that was *meant* to reason, named so the degradation is attributable. */
  reasonerModel: string;
  /** Why there is no reasoning, in the words of the error that caused it. */
  reason: string;
  now: Date;
  serialize?: SerializeOptions;
}

/**
 * The report you can still write when reasoning fails.
 *
 * "A partial investigation is a success" has always been about collectors, but the same argument
 * holds one step later: the timeline and the blind spots are *computed* from evidence and collector
 * runs, so they are exactly as trustworthy whether or not a model ever ran. Discarding them because
 * the interpretation failed throws away the reconstruction — which is the product — and hands an
 * on-call engineer an error at 3am instead.
 *
 * Found by running it: with a broken `GITHUB_TOKEN` the evidence set shrinks, the recorded response
 * cites a node that is no longer there, and the citation gate rightly rejects the whole response.
 * Rightly — the fix is not to loosen the gate, it is to still report what was never the model's to
 * write.
 *
 * There are deliberately **no** hypotheses. Not one uncited sentence about cause survives this
 * path; the summary describes the failure and nothing else.
 */
export function unreasonedReport(input: UnreasonedReportInput): InvestigationReport {
  const { investigation, graph, registry, runs, now } = input;

  const evidence = serializeForReasoning(graph, registry, input.serialize ?? {});

  // Error messages routinely end in a full stop and are routinely interpolated mid-sentence. Left
  // alone this renders "… E14.. The timeline", which reads as a typo in the one report a user is
  // least inclined to trust.
  const reason = input.reason.replace(/\.\s*$/, '');

  return {
    investigationId: investigation.id,
    orgId: investigation.orgId,
    summary:
      `I reconstructed what happened, but could not reason about it: ${reason}. ` +
      'The timeline and the blind spots below are computed from the evidence itself, ' +
      'so they stand — there is simply no interpretation of them here.',
    hypotheses: [],
    timeline: timelineFrom(graph, registry, evidence.idMap),
    missingInformation: missingInformationFrom(runs),
    suggestedQuestions: [],
    // Never passes for a reasoned report. A reader comparing two of these has to be able to see
    // which one had a model behind it. An em dash rather than brackets because the model name
    // already carries its own — `gemini-2.5-flash (replayed) (reasoning unavailable)` reads as a
    // bug in the renderer.
    model: `${input.reasonerModel} — reasoning unavailable`,
    promptVersion: PROMPT_VERSION,
    generatedAt: now,
  };
}

/**
 * Evidence that describes state rather than something that happened.
 *
 * Mirrors the "context" family in `@trace/domain`'s `kinds/context.ts`. A topology snapshot carries
 * the time it was taken and a past incident the time it occurred, so both sort into a timeline
 * perfectly happily and both are wrong there: one reads as though the service was created mid
 * incident, the other puts a five-month-old date at the top of today's sequence.
 *
 * They stay in the evidence graph and remain fully citable — precedent is often the most useful
 * thing in the graph. They are simply not part of the story of what happened.
 *
 * A plugin kind is treated as an event by default, which is the safer failure: a stray line in a
 * timeline is visible and correctable, whereas silently dropping a plugin's evidence is not.
 */
const NON_EVENT_KINDS = new Set(['service', 'past_incident']);

/**
 * Reads the timeline off the graph.
 *
 * `graph.nodes` is already ordered by `occurredAt` and deduplicated, so this is a projection rather
 * than a computation — which is the point. A generated timeline could reorder events, and the order
 * of events is the one thing an incident reconstruction must get right.
 *
 * Evidence elided from the prompt has no label and is skipped: a timeline entry the reader cannot
 * trace back to cited evidence is not verifiable.
 */
function timelineFrom(
  graph: EvidenceGraph,
  registry: EvidenceKindRegistry,
  idMap: ReadonlyMap<string, string>,
): readonly TimelineEntry[] {
  const labelOf = new Map([...idMap].map(([label, nodeId]) => [nodeId, label]));

  const entries: TimelineEntry[] = [];
  for (const node of graph.nodes) {
    if (NON_EVENT_KINDS.has(node.kind)) continue;

    const label = labelOf.get(node.id);
    if (label === undefined) continue;

    const definition = registry.get(node.kind, node.kindVersion);
    entries.push({
      label,
      at: node.occurredAt,
      kind: node.kind,
      summary: definition ? definition.summarize(node.payload) : `${node.kind} (unrecognised)`,
      ...(node.sourceUrl === undefined ? {} : { sourceUrl: node.sourceUrl }),
    });
  }

  return entries;
}
