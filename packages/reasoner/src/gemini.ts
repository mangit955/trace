import { buildPrompt } from './prompt.ts';
import {
  MalformedReasoningError,
  ReasonedOutput,
  type Reasoner,
  type ReasoningRequest,
} from './reasoner.ts';
import { GEMINI_RESPONSE_SCHEMA } from './schema.ts';

/**
 * Gemini 2.5 Flash on the Google AI Studio free tier, over the `generateContent` endpoint.
 *
 * `generateContent` is now labelled legacy in favour of the Interactions API, but it is fully
 * supported with no announced shutdown, while Interactions had breaking changes as recently as May
 * 2026. For a submission that must still run in six months, the stable surface wins; the `Reasoner`
 * interface is what makes that decision cheap to revisit.
 *
 * Written against `fetch` rather than an SDK, matching the GitHub collector: one fewer dependency,
 * and an injectable transport means every test here runs without a network or a key.
 *
 * **Free-tier prompts are used to improve Google's products** — confirmed on the pricing page. Trace
 * must therefore never point this at real incident telemetry; the seeded incident it is captured
 * against is entirely synthetic.
 */

const GENERATIVE_LANGUAGE_API = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** Enough to ride out a burst without leaving an engineer waiting at 3am. */
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Statuses worth trying again.
 *
 * Keyed off the HTTP status alone. The docs no longer document a `retryDelay` field, and the one
 * error-body example uses a string `code`, so parsing the body to decide would be guessing at a
 * contract that is not published. A 4xx other than 429 means the request itself is wrong, and
 * retrying it only spends quota to fail identically.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface GeminiReasonerOptions {
  apiKey: string | undefined;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Injected so backoff is instant and deterministic under test. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export function geminiReasoner(options: GeminiReasonerOptions): Reasoner {
  const apiKey = options.apiKey;
  if (!apiKey) {
    // Constructing an unusable reasoner would defer the failure to the middle of an incident.
    throw new Error('GEMINI_API_KEY is not set; construct the recorded reasoner instead.');
  }

  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? GENERATIVE_LANGUAGE_API;
  const call = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return {
    name: 'gemini',
    model,

    async reason(request: ReasoningRequest): Promise<ReasonedOutput> {
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(request) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      });

      const response = await withRetries(
        () =>
          call(`${baseUrl}/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              // In a header rather than the documented `?key=` query parameter: a key in a URL
              // ends up in proxy logs, browser history and error reports.
              'x-goog-api-key': apiKey,
            },
            body,
          }),
        { maxAttempts, sleep },
      );

      return parseCandidate(await response.json());
    },
  };
}

async function withRetries(
  attempt: () => Promise<Response>,
  options: { maxAttempts: number; sleep: (ms: number) => Promise<void> },
): Promise<Response> {
  let lastStatus = 0;

  for (let tries = 0; tries < options.maxAttempts; tries++) {
    const response = await attempt();
    if (response.ok) return response;

    lastStatus = response.status;
    if (!RETRYABLE.has(response.status)) break;
    if (tries === options.maxAttempts - 1) break;

    // Exponential with jitter: without jitter, several investigations rate-limited at once would
    // retry in lockstep and stay rate-limited together.
    const backoff = BASE_BACKOFF_MS * 2 ** tries;
    await options.sleep(backoff + Math.floor(Math.random() * BASE_BACKOFF_MS));
  }

  throw new Error(
    `Gemini returned ${lastStatus}` +
      (lastStatus === 429 ? ' (rate limited; the free tier is shared and bursty)' : ''),
  );
}

interface GenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
}

/**
 * Pulls the JSON out of the candidate and refuses to trust it.
 *
 * `finishReason` values are not enumerated in the documentation, so nothing branches on specific
 * strings — whatever the model reports is quoted verbatim into the error instead. A truncated
 * response then surfaces as "finishReason MAX_TOKENS" rather than an opaque JSON parse failure.
 */
function parseCandidate(payload: unknown): ReasonedOutput {
  const candidate = (payload as GenerateContentResponse).candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  const because = `finishReason ${candidate?.finishReason ?? 'absent'}`;

  if (text === undefined) {
    throw new MalformedReasoningError('gemini', `no candidate text (${because})`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MalformedReasoningError('gemini', `candidate was not valid JSON (${because})`);
  }

  const parsed = ReasonedOutput.safeParse(json);
  if (!parsed.success) {
    throw new MalformedReasoningError(
      'gemini',
      `${parsed.error.issues[0]?.message ?? 'unexpected shape'} (${because})`,
    );
  }

  return parsed.data;
}
