import { type GeminiReasonerOptions, geminiReasoner } from './gemini.ts';
import type { ReasonedOutput, Reasoner, ReasoningRequest } from './reasoner.ts';

/**
 * Choosing and composing reasoners, mirroring `selectCollectors` in `@trace/collectors`.
 *
 * Same shape of decision, same reasoning: Trace ships in two modes and switches between them by
 * configuration rather than by code change. With no key it replays; with a key it reasons live and
 * keeps the recording behind it.
 */

/** The subset of the environment the reasoner reads. */
export interface ReasonerEnv {
  GEMINI_API_KEY?: string | undefined;
  /** Pins the model. Present so a newer Flash needs no code change. */
  GEMINI_MODEL?: string | undefined;
}

/**
 * Falls back to a second reasoner when the first fails.
 *
 * A free tier is rate limited by design, so a 429 is a normal Tuesday rather than an exception,
 * and an investigation that dies because the quota ran out is the worst outcome available at 3am.
 *
 * The fallback is not a licence to answer anyway: if it has no recording for *this* incident it
 * raises rather than replaying another incident's reasoning, whose citations would resolve against
 * the wrong evidence.
 */
export function fallbackReasoner(primary: Reasoner, backup: Reasoner): Reasoner {
  // Reported provenance follows whoever last answered, so a replayed report never claims to be
  // live reasoning.
  let answered = primary;

  return {
    name: primary.name,
    get model(): string {
      return answered.model;
    },

    async reason(request: ReasoningRequest): Promise<ReasonedOutput> {
      try {
        const result = await primary.reason(request);
        answered = primary;
        return result;
      } catch {
        const result = await backup.reason(request);
        answered = backup;
        return result;
      }
    },
  };
}

export interface SelectReasonerInput {
  recorded: Reasoner;
  /** Overrides for the live reasoner, chiefly an injected `fetch` under test. */
  gemini?: Omit<GeminiReasonerOptions, 'apiKey' | 'model'>;
}

export function selectReasoner(env: ReasonerEnv, input: SelectReasonerInput): Reasoner {
  if (!env.GEMINI_API_KEY) return input.recorded;

  const live = geminiReasoner({
    apiKey: env.GEMINI_API_KEY,
    ...(env.GEMINI_MODEL === undefined ? {} : { model: env.GEMINI_MODEL }),
    ...input.gemini,
  });

  return fallbackReasoner(live, input.recorded);
}
