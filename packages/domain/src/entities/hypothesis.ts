import { z } from 'zod';
import { validateCitations } from '../citations.ts';
import { EvidenceNodeId, HypothesisId, InvestigationId, newId, OrgId } from '../ids.ts';

/**
 * A Hypothesis — what Trace *thinks*, as opposed to what it observed.
 *
 * This is the other half of the evidence firewall. The graph holds facts; this holds causal
 * claims. Keeping them in separate types (and separate tables) means:
 *
 *  - a conclusion can never be mistaken for an observation;
 *  - every hypothesis can be deleted and regenerated from unchanged evidence, so improving the
 *    reasoner does not require re-collecting anything;
 *  - "show me the evidence" is a lookup rather than an act of faith.
 *
 * A Hypothesis cannot be constructed without resolving its citations against the evidence the
 * model was actually shown, so an unsupported conclusion is unrepresentable.
 */

export const CitationStance = z.enum(['supports', 'contradicts']);
export type CitationStance = z.infer<typeof CitationStance>;

export const HypothesisCitation = z.object({
  /** The short label as it appeared in the prompt (`E7`), kept so report and prompt agree. */
  label: z.string(),
  nodeId: EvidenceNodeId,
  stance: CitationStance,
});
export type HypothesisCitation = z.infer<typeof HypothesisCitation>;

export const Hypothesis = z.object({
  id: HypothesisId,
  orgId: OrgId,
  investigationId: InvestigationId,
  statement: z.string().min(1).max(2000),
  /** 0–1. The model's own stated confidence, not a calibrated probability. */
  confidence: z.number().min(0).max(1),
  citations: z.array(HypothesisCitation).min(1),

  // Reproducibility. Without these, "why did it conclude that?" is unanswerable once the reasoner
  // or the prompt has moved on.
  model: z.string(),
  promptVersion: z.string(),
  /** Every node the model was shown, including those it chose not to cite. */
  evidenceSeen: z.array(EvidenceNodeId),
  createdAt: z.date(),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export interface CitationInput {
  label: string;
  stance: CitationStance;
}

export interface CreateHypothesisInput {
  orgId: OrgId;
  investigationId: InvestigationId;
  statement: string;
  confidence: number;
  citations: readonly CitationInput[];
  /** Label → node id, from the serializer. The only sanctioned way to resolve a citation. */
  idMap: ReadonlyMap<string, EvidenceNodeId>;
  model: string;
  promptVersion: string;
  evidenceSeen: readonly EvidenceNodeId[];
  now: Date;
}

export function createHypothesis(input: CreateHypothesisInput): Hypothesis {
  if (input.statement.trim().length === 0) {
    throw new Error('A hypothesis statement cannot be empty.');
  }

  // Throws UngroundedClaimError on an empty list and HallucinatedCitationError on a citation that
  // does not resolve. Deliberately before any other work — an ungrounded claim should not get as
  // far as being shaped into an object.
  const resolved = validateCitations(
    input.citations.map((citation) => citation.label),
    input.idMap,
  );

  if (!input.citations.some((citation) => citation.stance === 'supports')) {
    throw new Error(
      'A hypothesis needs at least one supporting citation. Evidence against a theory is not ' +
        'evidence for it.',
    );
  }

  const citations = input.citations.map((citation) => {
    const label = citation.label.trim().toUpperCase();
    const nodeId = resolved.get(label);
    if (nodeId === undefined) {
      // Unreachable: validateCitations would have thrown. Guards against a future refactor
      // quietly dropping the check.
      throw new Error(`Citation ${label} could not be resolved.`);
    }
    return { label, nodeId, stance: citation.stance };
  });

  return Hypothesis.parse({
    id: newId(HypothesisId),
    orgId: input.orgId,
    investigationId: input.investigationId,
    statement: input.statement.trim(),
    confidence: input.confidence,
    citations,
    model: input.model,
    promptVersion: input.promptVersion,
    evidenceSeen: [...input.evidenceSeen],
    createdAt: input.now,
  });
}
