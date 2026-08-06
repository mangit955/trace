/**
 * What the two Google AI Studio calls — reasoning and embedding — have in common.
 *
 * Extracted when the embedder arrived rather than up front: one copy of retry logic is a file, two
 * copies are a bug waiting for the day someone fixes the backoff in only one of them.
 *
 * Written against bare `fetch` rather than an SDK, matching the GitHub collector: one fewer
 * dependency, and an injectable transport means every test runs without a network or a key.
 */

export const GENERATIVE_LANGUAGE_API = 'https://generativelanguage.googleapis.com';

/** Enough to ride out a burst without leaving an engineer waiting at 3am. */
export const DEFAULT_MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 500;

/**
 * Statuses worth trying again.
 *
 * Keyed off the HTTP status alone. The docs no longer document a `retryDelay` field, and the one
 * error-body example uses a string `code`, so parsing the body to decide would be guessing at a
 * contract that is not published. A 4xx other than 429 means the request itself is wrong, and
 * retrying it only spends quota to fail identically.
 */
export const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface RetryOptions {
  maxAttempts: number;
  /** Injected so backoff is instant and deterministic under test. */
  sleep: (ms: number) => Promise<void>;
}

export async function withRetries(
  attempt: () => Promise<Response>,
  options: RetryOptions,
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
