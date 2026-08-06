import type { Investigation, SerializedEvidence } from '@trace/domain';
import { z } from 'zod';

/**
 * The reasoning port.
 *
 * Deliberately narrow: one call, in and out, with no knowledge of graphs, repositories or channels.
 * That is what lets the demo replay a captured response, the tests run without a network, and the
 * model behind it change without touching anything that reasons about incidents.
 *
 * A reasoner returns *claims*. It never returns the timeline or the list of blind spots — both are
 * computed from evidence and collector runs. See `report.ts`.
 */

export const CitationDraft = z.object({
  /** A label as it appeared in the prompt, e.g. `E4`. Resolved against the serializer's idMap. */
  label: z.string(),
  stance: z.enum(['supports', 'contradicts']),
});

export const HypothesisDraft = z.object({
  statement: z.string().min(1).max(2000),
  /** The model's own stated confidence, 0–1. Not a calibrated probability. */
  confidence: z.number().min(0).max(1),
  citations: z.array(CitationDraft),
});

/**
 * The exact shape a reasoner must return.
 *
 * Model output is untrusted input, so it is parsed rather than cast — a truncated response or a
 * confidence of 95 becomes a typed failure that falls back to a recorded response, instead of a
 * malformed report or a crash deep in the renderer.
 *
 * Unknown keys are stripped: a model that helpfully volunteers `missingInformation` must not have
 * it reach the report.
 */
export const ReasonedOutput = z.object({
  summary: z.string().min(1).max(4000),
  hypotheses: z.array(HypothesisDraft).min(1).max(10),
  suggestedQuestions: z.array(z.string().min(1).max(300)).max(10).default([]),
});
export type ReasonedOutput = z.infer<typeof ReasonedOutput>;

export interface ReasoningRequest {
  investigation: Investigation;
  evidence: SerializedEvidence;
  /** Computed by `missingInformationFrom`. Shown to the model, never solicited from it. */
  gaps: readonly string[];
}

export interface Reasoner {
  /** Identifies the implementation: `gemini`, `recorded`. */
  readonly name: string;
  /** The model identifier recorded on every hypothesis for reproducibility. */
  readonly model: string;
  reason(request: ReasoningRequest): Promise<ReasonedOutput>;
}

/** Raised when a reasoner returns something that is not a valid response. */
export class MalformedReasoningError extends Error {
  constructor(reasoner: string, detail: string) {
    super(`Reasoner "${reasoner}" returned an unusable response: ${detail}`);
    this.name = 'MalformedReasoningError';
  }
}
