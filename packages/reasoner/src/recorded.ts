import { z } from 'zod';
import {
  MalformedReasoningError,
  ReasonedOutput,
  type Reasoner,
  type ReasoningRequest,
} from './reasoner.ts';

/**
 * Replays a captured reasoning response.
 *
 * This is what makes the demo runnable with **zero credentials** and the test suite hermetic — a
 * reviewer sees a real investigation with real model prose without holding an API key, and no test
 * depends on a free tier's mood.
 *
 * It is deliberately incapable of improvising. A recording is bound to the incident it was captured
 * against, because its citations resolve against that incident's evidence graph and nothing else.
 * Replaying INC-481's reasoning for a different incident would produce citations that point at the
 * wrong evidence, which is precisely the failure the citation gate exists to prevent.
 */

export const Recording = z.object({
  /** The external incident id this was captured against, e.g. `INC-481`. */
  externalId: z.string().min(1),
  model: z.string().min(1),
  /** The prompt version in force at capture. Drift is caught by `recordings.test.ts`. */
  promptVersion: z.string().min(1),
  capturedAt: z.iso.datetime(),
  response: ReasonedOutput,
});
export type Recording = z.infer<typeof Recording>;

/** Raised when no capture exists for the incident under investigation. */
export class NoRecordingError extends Error {
  constructor(externalId: string) {
    super(
      `No recorded reasoning for incident ${externalId}. Recordings are captured per incident; ` +
        'set GEMINI_API_KEY to reason about one that has not been captured.',
    );
    this.name = 'NoRecordingError';
  }
}

export function recordedReasoner(recordings: readonly unknown[]): Reasoner {
  // Validated at construction: a malformed recording is a build-time mistake, and discovering it
  // mid-demo would be the worst possible moment.
  const parsed = recordings.map((entry) => {
    const result = Recording.safeParse(entry);
    if (!result.success) {
      const id =
        typeof entry === 'object' && entry !== null && 'externalId' in entry
          ? String((entry as { externalId: unknown }).externalId)
          : 'unknown';
      throw new MalformedReasoningError(
        'recorded',
        `recording for ${id} is invalid: ${result.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    return result.data;
  });

  const byIncident = new Map(parsed.map((entry) => [entry.externalId.toLowerCase(), entry]));

  // Named for what actually produced the prose, marked as a replay. A report that claimed to be
  // live reasoning when it is a recording would misrepresent itself to a reviewer.
  const models = [...new Set(parsed.map((entry) => entry.model))];
  const model = models.length === 1 && models[0] ? `${models[0]} (replayed)` : 'recorded';

  return {
    name: 'recorded',
    model,

    async reason(request: ReasoningRequest): Promise<ReasonedOutput> {
      const externalId = request.investigation.externalRef.id;
      const recording = byIncident.get(externalId.trim().toLowerCase());
      if (!recording) throw new NoRecordingError(externalId);

      return recording.response;
    },
  };
}
