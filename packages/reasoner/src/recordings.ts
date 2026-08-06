import type { Reasoner } from './reasoner.ts';
import { type Recording, recordedReasoner } from './recorded.ts';
import inc481 from './recordings/inc-481.json' with { type: 'json' };

/**
 * The reasoning captured from Gemini, committed so the demo needs no API key.
 *
 * These are genuine model responses produced by `bun run capture:reasoning` against the seeded
 * incident, not hand-written prose — which is the only reason a reviewer running Trace with zero
 * credentials sees what the product actually does rather than a mock of it.
 *
 * Captures are only ever taken against **synthetic** seeded incidents. Free-tier prompts are used
 * to improve Google's products, so real incident telemetry must never be sent to capture one.
 *
 * `recordings.test.ts` holds them to the live seeded graph and the current prompt version, because
 * a recording that has drifted from either describes a build that no longer exists.
 */
export const RECORDINGS: readonly Recording[] = [inc481 as Recording];

/**
 * The reasoner backing the credential-free demo, and the fallback when a live call fails.
 *
 * Validates every recording on construction, so a malformed capture fails at startup rather than
 * mid-incident.
 */
export function defaultRecordedReasoner(): Reasoner {
  return recordedReasoner(RECORDINGS);
}
