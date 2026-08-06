import { describe, expect, test } from 'bun:test';
import { EMBEDDING_DIMENSIONS, geminiEmbedder, lexicalEmbedder, selectEmbedder } from './embed.ts';

const noSleep = () => Promise.resolve();

function respondWith(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('lexicalEmbedder', () => {
  const embedder = lexicalEmbedder();

  test('produces a vector of the one width the column can hold', async () => {
    // Both backends must agree: `vector(768)` cannot hold two dimensions, and a mismatch is an
    // insert error in production long after the model was swapped.
    expect((await embedder.embed('payments-api pool exhaustion')).length).toBe(
      EMBEDDING_DIMENSIONS,
    );
  });

  test('is deterministic, so the same incident indexes to the same point', async () => {
    const once = await embedder.embed('payments-api 5xx spike');
    const again = await embedder.embed('payments-api 5xx spike');

    expect(again).toEqual(once);
  });

  test('scores shared vocabulary above unrelated text', async () => {
    // This is the whole claim the fallback makes — lexical overlap, not semantics — and it is worth
    // asserting rather than assuming, because a hash that spread tokens badly would retrieve noise
    // while still returning a plausible-looking vector.
    const incident = await embedder.embed('payments-api redis connection pool exhausted 5xx');
    const similar = await embedder.embed('payments-api redis pool exhausted again');
    const unrelated = await embedder.embed('checkout-web css bundle size regression');

    expect(cosine(incident, similar)).toBeGreaterThan(cosine(incident, unrelated));
  });

  test('is unit length, so cosine similarity is a dot product', async () => {
    const vector = await embedder.embed('payments-api');
    const magnitude = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));

    expect(magnitude).toBeCloseTo(1, 6);
  });

  test('returns a zero vector for text with nothing in it, rather than throwing', async () => {
    // An investigation whose summary failed to generate must still index. A throw here would fail
    // the whole investigation over a feature nobody asked for.
    expect(await embedder.embed('   ')).toEqual(new Array(EMBEDDING_DIMENSIONS).fill(0));
  });

  test('ignores case and punctuation, which differ between sources describing one service', async () => {
    expect(await embedder.embed('Payments-API: 5xx!')).toEqual(
      await embedder.embed('payments api 5xx'),
    );
  });
});

describe('geminiEmbedder', () => {
  test('asks for the dimension the schema was built for', async () => {
    // Gemini defaults to 3072. Taking the default would insert vectors the column rejects.
    let body: Record<string, unknown> = {};
    const embedder = geminiEmbedder({
      apiKey: 'k',
      sleep: noSleep,
      fetch: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ embedding: { values: new Array(EMBEDDING_DIMENSIONS).fill(0.1) } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    await embedder.embed('payments-api');

    expect(body['outputDimensionality']).toBe(EMBEDDING_DIMENSIONS);
  });

  test('sends the key in a header, never in the URL', async () => {
    // A key in a URL reaches proxy logs, browser history and error reports.
    let url = '';
    let headers: Record<string, string> = {};
    const embedder = geminiEmbedder({
      apiKey: 'secret-key',
      sleep: noSleep,
      fetch: (async (requestUrl: string, init: RequestInit) => {
        url = requestUrl;
        headers = init.headers as Record<string, string>;
        return new Response(
          JSON.stringify({ embedding: { values: new Array(EMBEDDING_DIMENSIONS).fill(0.1) } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    await embedder.embed('payments-api');

    expect(url).not.toContain('secret-key');
    expect(headers['x-goog-api-key']).toBe('secret-key');
  });

  test('rejects a response of the wrong width rather than storing it', async () => {
    // A silently truncated vector is worse than none: it inserts, it scores, and every neighbour
    // it returns is wrong.
    const embedder = geminiEmbedder({
      apiKey: 'k',
      sleep: noSleep,
      fetch: respondWith({ embedding: { values: [0.1, 0.2] } }),
    });

    await expect(embedder.embed('payments-api')).rejects.toThrow(/768/);
  });

  test('rejects a response with no embedding at all', async () => {
    const embedder = geminiEmbedder({
      apiKey: 'k',
      sleep: noSleep,
      fetch: respondWith({}),
    });

    await expect(embedder.embed('payments-api')).rejects.toThrow(/embedding/i);
  });

  test('retries a 429 and succeeds, since the free tier is bursty', async () => {
    let calls = 0;
    const embedder = geminiEmbedder({
      apiKey: 'k',
      sleep: noSleep,
      fetch: (async () => {
        calls += 1;
        if (calls === 1) return new Response('rate limited', { status: 429 });
        return new Response(
          JSON.stringify({ embedding: { values: new Array(EMBEDDING_DIMENSIONS).fill(0.1) } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    expect((await embedder.embed('payments-api')).length).toBe(EMBEDDING_DIMENSIONS);
    expect(calls).toBe(2);
  });

  test('refuses to construct without a key rather than failing mid-incident', () => {
    expect(() => geminiEmbedder({ apiKey: undefined })).toThrow(/GEMINI_API_KEY/);
  });
});

describe('similarity floors', () => {
  test('the lexical floor separates a real match from same-service noise', async () => {
    // Measured, not guessed: a genuinely similar incident scores 0.94, an unrelated one 0.55, and
    // the same service failing differently 0.64. The floor has to sit between the last two.
    const embedder = lexicalEmbedder();
    const query = await embedder.embed(
      'payments-api redis-primary redis connection pool exhausted REDIS_POOL_MAX lowered',
    );

    const similar = await embedder.embed(
      'payments-api redis-primary redis connection pool exhausted after a pool size change',
    );
    const sameServiceDifferentFailure = await embedder.embed(
      'payments-api p99 latency above SLO after a slow database migration held table locks',
    );

    expect(cosine(query, similar)).toBeGreaterThan(embedder.minSimilarity);
    expect(cosine(query, sameServiceDifferentFailure)).toBeLessThan(embedder.minSimilarity);
  });

  test('Gemini’s floor is far higher than the lexical one, because its scale is compressed', () => {
    // The bug this encodes: a single constant showed "broken image links after a CMS migration" as
    // 87% similar to a Redis outage, because Gemini rates unrelated incident text above 0.86.
    const gemini = geminiEmbedder({ apiKey: 'k' });

    expect(gemini.minSimilarity).toBeGreaterThan(lexicalEmbedder().minSimilarity);
    expect(gemini.minSimilarity).toBeGreaterThan(0.88);
  });
});

describe('selectEmbedder', () => {
  test('falls back to the lexical embedder with no key, so the demo still answers', () => {
    // The demo must run with zero credentials. "Has this happened before" degrades to lexical
    // overlap rather than disappearing.
    expect(selectEmbedder({}).model).toBe('lexical-v1');
  });

  test('uses Gemini when a key is present', () => {
    expect(selectEmbedder({ GEMINI_API_KEY: 'k' }).model).toContain('embedding');
  });

  test('treats an empty key as no key', () => {
    // An unset variable in a .env file arrives as '', which would otherwise construct a client
    // that 400s on every call.
    expect(selectEmbedder({ GEMINI_API_KEY: '' }).model).toBe('lexical-v1');
  });
});

/** Mapped onto [0, 1], matching what both stores return. Vectors here are already unit length. */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return (dot + 1) / 2;
}
