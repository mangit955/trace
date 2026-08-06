import {
  assertGrounded,
  type EvidenceGraph,
  type EvidenceKindRegistry,
  type Investigation,
  serializeForReasoning,
} from '@trace/domain';
import type { Reasoner } from './reasoner.ts';

/**
 * Answering a follow-up question about an investigation.
 *
 * Structured reports are the main path; this is what happens when someone asks something the intent
 * parser cannot classify — "was the pool ever raised back to 50?". Refusing to answer would be the
 * wrong product: the whole promise is a colleague who has read the evidence.
 *
 * The safety property is the same as everywhere else, and it is not negotiable for being
 * conversational: **the answer is checked against the evidence before it is sent**. Free-form prose
 * is precisely where an uncited assertion would otherwise slip past unnoticed, so `assertGrounded`
 * runs on the way out and an answer citing evidence that was never collected never reaches the user.
 *
 * The labels are recovered by re-serializing the stored graph rather than being carried between
 * turns. That is safe because evidence is immutable and `serializeForReasoning` is deterministic, so
 * `E4` means the same node in this turn as it did when the report was written.
 */

/** Raised when the configured reasoner cannot answer free-form questions. */
export class NoAnswererError extends Error {
  constructor(reasoner: string) {
    super(
      `Reasoner "${reasoner}" cannot answer free-form questions. ` +
        'Set GEMINI_API_KEY to enable them; recorded reasoning replays reports only.',
    );
    this.name = 'NoAnswererError';
  }
}

export interface AnswerQuestionInput {
  question: string;
  investigation: Investigation;
  graph: EvidenceGraph;
  registry: EvidenceKindRegistry;
  reasoner: Reasoner;
  /**
   * Caspian's own guidance for the channel this will be sent on, from `behaviorPrompt()` or
   * `channelGuide()`. Passed through rather than reinvented — Caspian knows that X caps a post at
   * 300 characters and that iMessage renders no markdown, and it would be silly to encode that
   * here and let it drift.
   */
  behaviourGuide?: string;
}

export async function answerQuestion(input: AnswerQuestionInput): Promise<string> {
  const { reasoner } = input;
  if (!reasoner.answer) throw new NoAnswererError(reasoner.name);

  const evidence = serializeForReasoning(input.graph, input.registry);

  const answer = await reasoner.answer({
    prompt: buildAnswerPrompt(input, evidence.text),
    investigation: input.investigation,
  });

  // Throws UngroundedClaimError when nothing is cited and HallucinatedCitationError when a label
  // does not resolve. Either way the caller sends an honest failure rather than a confident guess.
  assertGrounded(answer, evidence.idMap);

  return answer;
}

function buildAnswerPrompt(input: AnswerQuestionInput, evidenceText: string): string {
  return [
    'You are Trace, an incident investigator answering a follow-up question.',
    '',
    'Rules:',
    '1. Answer only from the evidence below. If it does not say, say that it does not say.',
    '2. Cite every claim by its label in brackets, like [E4]. An answer citing a label that is not',
    '   below will be rejected and never reach the user, so cite only what you can see.',
    '3. Be brief. This is a chat message during an incident, not a report.',
    ...(input.behaviourGuide ? ['', 'Channel etiquette:', input.behaviourGuide] : []),
    '',
    `# Incident`,
    `${input.investigation.externalRef.system} ${input.investigation.externalRef.id}`,
    '',
    evidenceText,
    '',
    '# Question',
    input.question,
  ].join('\n');
}
