import { DEFAULT_MAX_ATTEMPTS, GENERATIVE_LANGUAGE_API, withRetries } from './google.ts';

/**
 * Turning an investigation into a point in space, so "has this happened before?" is a query.
 *
 * A port, exactly like `Reasoner`, and for the same reason: the answer to "which embedding
 * provider" should be a line in the composition root rather than a decision the storage layer or
 * the handler knows about. Two implementations ship —
 *
 *  - `geminiEmbedder`, when `GEMINI_API_KEY` is set;
 *  - `lexicalEmbedder`, when it is not.
 *
 * The fallback is **not** a stub and **not** semantic. It is a deterministic hashed bag of tokens:
 * two incidents that name the same services and the same error terms land near each other, and two
 * that describe the same failure in different words do not. That is a real and useful retrieval for
 * incident text, which is heavy on identifiers — `payments-api`, `ECONNRESET`, `pool exhausted` —
 * and it is honest about being lexical rather than pretending to understand. It exists because the
 * demo must run with zero credentials, and a feature that vanishes without a key is a feature a
 * reviewer never sees.
 */

/**
 * One width, both backends.
 *
 * A `vector(n)` column cannot hold two dimensions, so this is pinned rather than taken from
 * whatever each provider defaults to — Gemini's default is 3072, which would insert fine until the
 * day someone ran without a key and the lexical vector was rejected. 768 is a documented Gemini
 * output size and small enough that an HNSW index over it is cheap.
 */
export const EMBEDDING_DIMENSIONS = 768;

export interface Embedder {
  /** Recorded alongside the vector, so a stale embedding is identifiable after a model change. */
  readonly model: string;
  /**
   * The score below which a match is noise, for *this* model.
   *
   * A property of the embedder rather than a constant at the call site, because the two backends
   * do not share a scale at all. Measured by scoring `similaritySourceText` for the seeded incident
   * — the **real** query, not a hand-written approximation — against four candidates:
   *
   * ```
   *                                    lexical   gemini
   *   genuinely similar incident        0.7188   0.9516
   *   same service, different failure   0.6506   0.9204
   *   unrelated                         0.5118   0.8724
   *   entirely unrelated                0.5284   0.8808
   * ```
   *
   * Gemini compresses everything into [0.87, 0.96]: its score for *unrelated* text is higher than
   * the lexical embedder's for a genuine match. A single shared threshold would show every incident
   * as precedent on Gemini or none on lexical — and the first is what it did, presenting "broken
   * image links after a CMS migration" as 87% similar to a Redis outage. A precedent section that
   * cries wolf is worse than none, because an engineer learns to skip it.
   *
   * **Calibrated on one incident.** There is a single seeded incident to measure against, so these
   * separate a real match from a decoy on the evidence available and no more; the margins are
   * ~0.03 either side. Worth re-measuring against real history before trusting the section, and the
   * mechanism — a per-model floor — matters more here than the constants.
   */
  readonly minSimilarity: number;
  embed(text: string): Promise<readonly number[]>;
}

const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

export interface GeminiEmbedderOptions {
  apiKey: string | undefined;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export function geminiEmbedder(options: GeminiEmbedderOptions): Embedder {
  const apiKey = options.apiKey;
  if (!apiKey) {
    // Constructing an unusable embedder would defer the failure to the middle of an incident.
    throw new Error('GEMINI_API_KEY is not set; construct the lexical embedder instead.');
  }

  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const baseUrl = options.baseUrl ?? GENERATIVE_LANGUAGE_API;
  const call = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return {
    model,
    // Between "same service, different failure" (0.9204) and a genuine match (0.9516). The former
    // is deliberately excluded: precedent means "this has happened before", and a latency incident
    // on the same service has not.
    minSimilarity: 0.94,

    async embed(text: string): Promise<readonly number[]> {
      const response = await withRetries(
        () =>
          call(`${baseUrl}/v1beta/models/${model}:embedContent`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              // In a header rather than the documented `?key=` query parameter: a key in a URL ends
              // up in proxy logs, browser history and error reports.
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              // Explicit, because the default is 3072 and the column holds 768.
              outputDimensionality: EMBEDDING_DIMENSIONS,
              // The corpus and the query are the same kind of text — an incident description — so
              // both sides use one task type rather than the asymmetric query/document pair.
              taskType: 'SEMANTIC_SIMILARITY',
            }),
          }),
        { maxAttempts, sleep },
      );

      const payload = (await response.json()) as { embedding?: { values?: number[] } };
      const values = payload.embedding?.values;

      if (!values) {
        throw new Error(`No embedding in the ${model} response.`);
      }

      // A silently truncated vector is worse than none: it inserts, it scores, and every neighbour
      // it returns is wrong.
      if (values.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `${model} returned a ${values.length}-dimension embedding; ` +
            `${EMBEDDING_DIMENSIONS} is what the schema holds.`,
        );
      }

      return values;
    },
  };
}

/**
 * The credential-free embedder: a deterministic hashed bag of tokens, L2-normalised.
 *
 * Sometimes called the hashing trick. Each token is hashed to a bucket and adds its weight there,
 * so vocabulary overlap becomes vector proximity with no vocabulary list to maintain and no model
 * to call. Normalised to unit length so cosine similarity is a plain dot product and scores are
 * comparable with Gemini's.
 *
 * `lexical-v1` in the version string is deliberate. The vector is stored next to the model that
 * produced it, so an operator who later adds a key can see exactly which investigations were
 * indexed lexically and reindex them.
 */
export function lexicalEmbedder(): Embedder {
  return {
    model: 'lexical-v1',
    // Between "same service, different failure" (0.6506) and a genuine match (0.7188). Unrelated
    // text sits at ~0.52, well clear.
    minSimilarity: 0.68,

    async embed(text: string): Promise<readonly number[]> {
      const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      const tokens = tokenize(text);

      for (const token of tokens) {
        // Two hashes per token: one picks the bucket, one picks the sign. The sign keeps unrelated
        // tokens that collide into a bucket from always reinforcing each other, which would make
        // everything look similar to everything.
        const bucket = hash(token, 0x9e3779b9) % EMBEDDING_DIMENSIONS;
        const sign = hash(token, 0x85ebca6b) % 2 === 0 ? 1 : -1;
        vector[bucket] = (vector[bucket] ?? 0) + sign;
      }

      const magnitude = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
      // An investigation whose summary failed to generate must still index; a throw here would fail
      // the whole investigation over a secondary feature. A zero vector scores 0 against everything,
      // which is the honest answer.
      if (magnitude === 0) return vector;

      return vector.map((x) => x / magnitude);
    },
  };
}

/**
 * Words, lowercased, punctuation dropped.
 *
 * Hyphens included as separators so `payments-api` also contributes `payments` and `api` — the same
 * service is written both ways across PagerDuty, GitHub and a human typing at 3am.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** FNV-1a, seeded. Not cryptographic — nothing here is a security boundary, only a bucket choice. */
function hash(token: string, seed: number): number {
  let value = seed >>> 0;
  for (let i = 0; i < token.length; i++) {
    value ^= token.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/**
 * The composition decision, mirroring `selectReasoner`.
 *
 * No key ⇒ lexical, so `bun run dev` answers "have we seen this before" with no credentials at all.
 */
export function selectEmbedder(env: { GEMINI_API_KEY?: string }): Embedder {
  const apiKey = env.GEMINI_API_KEY;
  // An unset variable in a .env file arrives as the empty string, which would otherwise build a
  // client that 400s on every call.
  if (!apiKey || apiKey.trim().length === 0) return lexicalEmbedder();

  return geminiEmbedder({ apiKey });
}
