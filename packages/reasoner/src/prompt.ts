import type { Investigation, SerializedEvidence } from '@trace/domain';

/**
 * The reasoning prompt.
 *
 * Byte-identical for identical input, for the same reasons `serialize.ts` is: prompt caching only
 * works on a stable prefix, and a stored hypothesis is only explainable later if the prompt that
 * produced it can be reconstructed exactly. `PROMPT_VERSION` is recorded on every hypothesis, so a
 * change here is traceable rather than silent.
 */

/** Bump on any change to the text below. Recorded on every hypothesis for reproducibility. */
export const PROMPT_VERSION = 'investigate/v1';

export interface BuildPromptInput {
  investigation: Investigation;
  evidence: SerializedEvidence;
  /** Computed from collector runs by `missingInformationFrom`. Never asked of the model. */
  gaps: readonly string[];
}

/**
 * What the model is for, and what it is emphatically not for.
 *
 * The instruction to leave gaps alone is not politeness — the report's `missingInformation` is
 * computed from collector runs regardless of what comes back. Telling the model anyway stops it
 * reasoning as though the evidence set were complete, which is a different and real failure.
 */
const SYSTEM = `You are Trace, an incident investigator. You reconstruct what happened during a
production incident from collected evidence, and you never fix anything.

Rules, in order of importance:

1. Every claim you make must cite evidence by its label, written in brackets, like [E4]. A claim
   without a citation will be rejected. A citation to a label that does not appear in the evidence
   below will be rejected and the whole response discarded.
2. Evidence records what was observed. Causation is yours to propose, as a hypothesis with a
   confidence score — never state a cause as though it were observed.
3. Prefer the change that best explains the symptoms, but say so when the evidence is thin. A
   hypothesis at 0.4 confidence is more useful than a confident guess.
4. Do not list gaps, blind spots or missing evidence. Those are computed from which collectors ran
   and are supplied to you below; anything you add would be invention.
5. Weigh changes inside the window heavily, but do not assume the nearest change is the cause.
   Evidence that argues against a hypothesis should be cited with the "contradicts" stance.`;

export function buildPrompt(input: BuildPromptInput): string {
  const { investigation, evidence, gaps } = input;
  const { externalRef, window } = investigation;

  const knownGaps =
    gaps.length > 0
      ? [
          'Some sources did not report. Reason accordingly — do not treat the evidence as complete,',
          'and do not restate this list in your answer:',
          ...gaps.map((gap) => `- ${gap}`),
        ].join('\n')
      : 'Every configured source reported successfully.';

  return [
    SYSTEM,
    '',
    `# Incident`,
    `${externalRef.system} ${externalRef.id}`,
    `Evidence was searched between ${window.from.toISOString()} and ${window.to.toISOString()}.`,
    '',
    evidence.text,
    '',
    '# Collection coverage',
    knownGaps,
    '',
    '# Your task',
    'Summarise what happened, propose the hypotheses the evidence supports, and suggest the',
    'questions an on-call engineer should ask next. Cite evidence labels throughout.',
  ].join('\n');
}
