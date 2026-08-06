import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  newId,
  OrgId,
  registerCoreKinds,
  serializeForReasoning,
} from '@trace/domain';
import { geminiReasoner } from './gemini.ts';
import type { ReasoningRequest } from './reasoner.ts';

const ALERT_AT = new Date('2026-08-06T10:16:00.000Z');

const registry = new EvidenceKindRegistry();
registerCoreKinds(registry);

const investigation = createInvestigation({
  orgId: newId(OrgId),
  externalRef: { system: 'pagerduty', id: 'INC-481' },
  window: defaultWindowFor(ALERT_AT),
  now: ALERT_AT,
});

const request: ReasoningRequest = {
  investigation,
  evidence: serializeForReasoning(
    buildEvidenceGraph({ investigationId: investigation.id, nodes: [], edges: [] }),
    registry,
  ),
  gaps: [],
};

const answer = {
  summary: 'A deploy preceded the spike [E1].',
  hypotheses: [
    {
      statement: 'The deploy did it.',
      confidence: 0.8,
      citations: [{ label: 'E1', stance: 'supports' }],
    },
  ],
  suggestedQuestions: ['Roll back?'],
};

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * Replies with the given sequence of responses, one per attempt.
 *
 * Responses are built per call rather than reused, because a `Response` body can only be read
 * once and a retry test necessarily reads several.
 */
function fakeGemini(responses: readonly (() => Response)[]) {
  const calls: Call[] = [];
  let attempt = 0;

  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const build = responses[attempt] ?? responses.at(-1);
    attempt++;
    if (!build) throw new Error('no fake response configured');
    return build();
  };

  return { fetch: impl as unknown as typeof fetch, calls };
}

function ok(payload: unknown, finishReason = 'STOP'): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason }],
    }),
    { status: 200 },
  );
}

function reasoner(responses: readonly (() => Response)[], overrides = {}) {
  const { fetch, calls } = fakeGemini(responses);
  const slept: number[] = [];

  return {
    calls,
    slept,
    subject: geminiReasoner({
      apiKey: 'test-key',
      fetch,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      ...overrides,
    }),
  };
}

describe('the Gemini reasoner', () => {
  test('calls generateContent for the configured model', async () => {
    const { subject, calls } = reasoner([() => ok(answer)], { model: 'gemini-2.5-flash' });

    await subject.reason(request);

    expect(calls[0]?.url).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
  });

  test('authenticates without putting the key in the URL', async () => {
    // A key in a query string ends up in proxy logs and shell history.
    const { subject, calls } = reasoner([() => ok(answer)]);

    await subject.reason(request);

    expect(calls[0]?.headers.get('x-goog-api-key')).toBe('test-key');
    expect(calls[0]?.url).not.toContain('test-key');
  });

  test('asks for JSON against a declared schema', async () => {
    const { subject, calls } = reasoner([() => ok(answer)]);

    await subject.reason(request);
    const config = calls[0]?.body['generationConfig'] as Record<string, unknown>;

    expect(config['responseMimeType']).toBe('application/json');
    expect(config['responseSchema']).toBeDefined();
  });

  test('returns the parsed candidate text', async () => {
    const { subject } = reasoner([() => ok(answer)]);

    expect((await subject.reason(request)).summary).toBe('A deploy preceded the spike [E1].');
  });

  test('retries a rate-limited request and succeeds', async () => {
    // Rate limits are the normal condition of a free tier, not an exceptional one.
    const { subject, slept } = reasoner([
      () => new Response('{}', { status: 429 }),
      () => ok(answer),
    ]);

    expect((await subject.reason(request)).summary).toBe('A deploy preceded the spike [E1].');
    expect(slept).toHaveLength(1);
  });

  test('backs off for longer on each successive attempt', async () => {
    const { subject, slept } = reasoner(
      [
        () => new Response('{}', { status: 503 }),
        () => new Response('{}', { status: 503 }),
        () => ok(answer),
      ],
      { maxAttempts: 3 },
    );

    await subject.reason(request);

    expect(slept[1]).toBeGreaterThan(slept[0] ?? 0);
  });

  test('gives up after the attempt budget, naming the status', async () => {
    const { subject, calls } = reasoner([() => new Response('{}', { status: 429 })], {
      maxAttempts: 2,
    });

    expect(subject.reason(request)).rejects.toThrow(/429/);
    await Bun.sleep(1);
    expect(calls).toHaveLength(2);
  });

  test('does not retry a request the server rejected outright', async () => {
    // A 400 means the request is wrong; retrying it just spends quota to fail again.
    const { subject, calls } = reasoner([() => new Response('{}', { status: 400 })]);

    expect(subject.reason(request)).rejects.toThrow(/400/);
    await Bun.sleep(1);
    expect(calls).toHaveLength(1);
  });

  test('reports why a response was unusable, since the docs do not enumerate the reasons', async () => {
    const truncated = () =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '{"summary": "cut off' }] }, finishReason: 'MAX_TOKENS' },
          ],
        }),
        { status: 200 },
      );
    const { subject } = reasoner([truncated]);

    expect(subject.reason(request)).rejects.toThrow(/MAX_TOKENS/);
  });

  test('refuses to run without an API key', () => {
    expect(() => geminiReasoner({ apiKey: undefined })).toThrow(/GEMINI_API_KEY/);
  });

  test('answers a free-form question as plain prose', async () => {
    const prose = new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'The pool was never raised [E4].' }] },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200 },
    );
    const { subject, calls } = reasoner([() => prose]);

    const answer = await subject.answer?.({ prompt: 'Was it raised?', investigation });

    expect(answer).toBe('The pool was never raised [E4].');
    // No response schema: this path wants prose, and forcing JSON onto it would make the model
    // wrap a chat reply in an object for no reason.
    expect(calls[0]?.body['generationConfig']).toBeUndefined();
  });
});
