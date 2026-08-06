/**
 * `@trace/reasoner` — turning an evidence graph into an answer, without letting the model invent
 * anything it was not shown.
 *
 * The contract worth knowing before using this: a reasoner returns *claims* only. The timeline is
 * read off the evidence graph and the blind spots come from collector runs, because a model cannot
 * introspect what it was never shown and will confidently produce a plausible, wrong list if asked.
 * Every claim is resolved against the evidence the model actually saw before it becomes a
 * `Hypothesis`, so an unsupported conclusion is unrepresentable rather than merely discouraged.
 *
 * With no `GEMINI_API_KEY`, `selectReasoner` replays a genuine captured response and everything
 * still works.
 */

export {
  type GeminiReasonerOptions,
  geminiReasoner,
} from './gemini.ts';
export { type BuildPromptInput, buildPrompt, PROMPT_VERSION } from './prompt.ts';
export {
  MalformedReasoningError,
  ReasonedOutput,
  type Reasoner,
  type ReasoningRequest,
} from './reasoner.ts';
export { NoRecordingError, Recording, recordedReasoner } from './recorded.ts';
export { defaultRecordedReasoner, RECORDINGS } from './recordings.ts';
export {
  type InvestigationReport,
  type ReasonAboutInvestigationInput,
  reasonAboutInvestigation,
  type TimelineEntry,
} from './report.ts';
export { GEMINI_RESPONSE_SCHEMA } from './schema.ts';
export {
  fallbackReasoner,
  type ReasonerEnv,
  type SelectReasonerInput,
  selectReasoner,
} from './select.ts';
