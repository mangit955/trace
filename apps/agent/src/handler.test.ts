import { beforeEach, describe, expect, test } from 'bun:test';
import { fixtureCollectors, INC_481 } from '@trace/collectors/fixtures';
import { InMemoryStore } from '@trace/db';
import { EvidenceKindRegistry, newId, OrgId, registerCoreKinds, systemClock } from '@trace/domain';
import { defaultRecordedReasoner } from '@trace/reasoner';
import { type AgentDeps, handleMessage } from './handler.ts';
import type { InboundMessage } from './message.ts';

const orgId = newId(OrgId);

function deps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  const registry = new EvidenceKindRegistry();
  registerCoreKinds(registry);

  return {
    store: new InMemoryStore(),
    registry,
    reasoner: defaultRecordedReasoner(),
    collectorsFor: () => fixtureCollectors(INC_481),
    seededIncidents: [INC_481],
    tenant: { orgId },
    clock: systemClock,
    ...overrides,
  };
}

function inbound(
  text: string | null,
  conversationId = 'telegram:1',
  channel = 'telegram',
): InboundMessage {
  return { text, channel, conversationId };
}

let shared: AgentDeps;

beforeEach(() => {
  shared = deps();
});

describe('investigating', () => {
  test('reconstructs the incident and reports what it found', async () => {
    const reply = await handleMessage(shared, inbound('investigate INC-481'));

    expect(reply.text).toContain('INC-481');
    expect(reply.text).toContain('REDIS_POOL_MAX');
    expect(reply.blocks?.length).toBeGreaterThan(0);
  });

  test('says so plainly when it has never heard of the incident', async () => {
    // Inventing an investigation for an unknown id would be the worst possible failure here.
    const reply = await handleMessage(shared, inbound('investigate INC-999'));

    expect(reply.text).toMatch(/INC-999/);
    expect(reply.text).toMatch(/don't know|do not know|no incident/i);
  });

  test('remembers the investigation for the conversation it happened in', async () => {
    await handleMessage(shared, inbound('investigate INC-481', 'telegram:7'));

    expect(await shared.store.conversations.resolve(shared.tenant, 'telegram:7')).toBeDefined();
  });

  test('reuses the existing investigation when asked about the same incident twice', async () => {
    // Mirrors an external incident: a webhook delivered three times must produce one
    // investigation, not three, and re-asking is the same idempotency question.
    await handleMessage(shared, inbound('investigate INC-481', 'telegram:1'));
    const first = await shared.store.conversations.resolve(shared.tenant, 'telegram:1');

    await handleMessage(shared, inbound('investigate INC-481', 'telegram:2'));
    const second = await shared.store.conversations.resolve(shared.tenant, 'telegram:2');

    expect(second).toBe(first);
  });
});

describe('following up', () => {
  test('a bare "why?" resolves to the investigation in that thread', async () => {
    await handleMessage(shared, inbound('investigate INC-481', 'telegram:1'));

    const reply = await handleMessage(shared, inbound('why?', 'telegram:1'));

    expect(reply.text).toContain('REDIS_POOL_MAX');
    expect(reply.text).toMatch(/supported by/i);
  });

  test('a "why?" in a thread with no investigation asks which incident', async () => {
    const reply = await handleMessage(shared, inbound('why?', 'telegram:cold'));

    expect(reply.text).toMatch(/which incident/i);
  });

  test('does not leak one conversation’s investigation into another', async () => {
    await handleMessage(shared, inbound('investigate INC-481', 'telegram:1'));

    const reply = await handleMessage(shared, inbound('why?', 'slack:other'));

    expect(reply.text).toMatch(/which incident/i);
  });

  test('shows a specific piece of evidence when asked', async () => {
    await handleMessage(shared, inbound('investigate INC-481', 'telegram:1'));

    const reply = await handleMessage(shared, inbound('show deploy', 'telegram:1'));

    expect(reply.text).toContain('payments-api');
    expect(reply.text).toContain('v2.4.1');
  });

  test('says what it has when asked to show something it does not hold', async () => {
    await handleMessage(shared, inbound('investigate INC-481', 'telegram:1'));

    const reply = await handleMessage(
      shared,
      inbound('show me the kubernetes events', 'telegram:1'),
    );

    expect(reply.text).toMatch(/nothing|no evidence/i);
  });
});

describe('help and unrecognised messages', () => {
  test('offers help when asked', async () => {
    expect((await handleMessage(shared, inbound('help'))).text).toContain('investigate');
  });

  test('offers help for a message with no text at all', async () => {
    // A photo or voice note. Nullable upstream, and it must not throw.
    expect((await handleMessage(shared, inbound(null))).text).toContain('investigate');
  });

  test('falls back to help when the reasoner cannot answer free-form questions', async () => {
    // The recorded reasoner replays reports and cannot improvise, which is the zero-credential
    // default. Better an honest "here is what I can do" than a fabricated answer.
    await handleMessage(shared, inbound('investigate INC-481', 'telegram:1'));

    const reply = await handleMessage(
      shared,
      inbound('was the pool ever raised back?', 'telegram:1'),
    );

    expect(reply.text).toMatch(/investigate/);
  });

  test('says free-form answers need a key, rather than silently showing help', async () => {
    // Found by running the credential-free REPL: asking a question returned bare help text, so a
    // reviewer could not tell a missing key from a broken bot. `NoAnswererError` already carried
    // exactly the right sentence and the handler was discarding it.
    await handleMessage(shared, inbound('investigate INC-481', 'telegram:1'));

    const reply = await handleMessage(shared, inbound('who deployed it?', 'telegram:1'));

    expect(reply.text).toContain('GEMINI_API_KEY');
  });

  test('stays quiet about why when an answer fails its citation check', async () => {
    // The other branch of the same catch, and it must NOT gain an explanation: an ungrounded answer
    // is a safety failure, not a configuration gap, and naming a credential would suggest that
    // setting one makes the ungrounded answer appear.
    const ungrounded = deps({
      reasoner: {
        name: 'ungrounded',
        model: 'ungrounded-1',
        reason: defaultRecordedReasoner().reason.bind(defaultRecordedReasoner()),
        // E999 was never collected, so `assertGrounded` rejects this on the way out.
        answer: async () => 'It was the flag [E999].',
      },
    });
    await handleMessage(ungrounded, inbound('investigate INC-481', 'telegram:1'));

    const reply = await handleMessage(ungrounded, inbound('who deployed it?', 'telegram:1'));

    expect(reply.text).not.toContain('GEMINI_API_KEY');
    expect(reply.text).toContain('investigate');
  });
});

describe('channel etiquette', () => {
  function answering() {
    const prompts: string[] = [];
    const asked: string[] = [];

    const withAnswers = deps({
      reasoner: {
        name: 'stub',
        model: 'stub-1',
        reason: defaultRecordedReasoner().reason.bind(defaultRecordedReasoner()),
        answer: async (request) => {
          prompts.push(request.prompt);
          return 'The pool was never raised [E4].';
        },
      },
      behaviourGuideFor: async (channel: string) => {
        asked.push(channel);
        return `## ${channel}\n- Keep it short.`;
      },
    });

    return { deps: withAnswers, prompts, asked };
  }

  test('asks Caspian how to behave on the channel the question arrived on', async () => {
    // Caspian knows each channel's rules — Slack's mrkdwn is not standard markdown, X caps a post
    // at 300 characters — and keeps them current. Restating them here would only drift.
    const { deps: subject, asked } = answering();
    await handleMessage(subject, inbound('investigate INC-481', 'c:1', 'slack'));

    await handleMessage(subject, inbound('was the pool raised back?', 'c:1', 'slack'));

    expect(asked).toContain('slack');
  });

  test('folds that etiquette into the answer it asks for', async () => {
    const { deps: subject, prompts } = answering();
    await handleMessage(subject, inbound('investigate INC-481', 'c:1', 'telegram'));

    await handleMessage(subject, inbound('was the pool raised back?', 'c:1', 'telegram'));

    expect(prompts[0]).toContain('Keep it short.');
  });

  test('answers fine when no etiquette is available', async () => {
    const { deps: subject } = answering();
    const without = { ...subject };
    delete without.behaviourGuideFor;
    await handleMessage(without, inbound('investigate INC-481', 'c:1'));

    const reply = await handleMessage(without, inbound('was the pool raised back?', 'c:1'));

    expect(reply.text).toContain('[E4]');
  });
});

describe('surviving failure', () => {
  test('apologises rather than throwing when something goes wrong', async () => {
    // Caspian's listen() logs and skips a throwing handler, so an uncaught error would leave the
    // user with silence. Silence during an incident is worse than an apology.
    const broken = deps({
      collectorsFor: () => {
        throw new Error('collector wiring is broken');
      },
    });

    const reply = await handleMessage(broken, inbound('investigate INC-481'));

    expect(reply.text).toMatch(/sorry|went wrong/i);
  });

  test('still reports the reconstruction when the reasoner fails', async () => {
    // "A partial investigation is a success" applies one step later than it was written for. The
    // timeline and the blind spots are computed from evidence, not written by the model, so a
    // failed reasoner must not take them down with it. Hit for real by pointing a broken
    // GITHUB_TOKEN at the credential-free path: the evidence set shrank, the recorded response
    // cited a node that was gone, and the whole investigation came back as an apology.
    const failing = deps({
      reasoner: {
        name: 'failing',
        model: 'failing-1',
        reason: async () => {
          throw new Error('the recorded response cites evidence that was not collected');
        },
      },
    });

    const reply = await handleMessage(failing, inbound('investigate INC-481', 'c:1'));

    expect(reply.text).not.toMatch(/sorry|went wrong/i);
    // The reconstruction survives: the deploy is still there, in order.
    expect(reply.text).toContain('Timeline:');
    expect(reply.text).toContain('v2.4.1');
    // And it says why there is no conclusion, rather than inventing one.
    expect(reply.text).toContain('could not reason about it');
    expect(reply.text).not.toContain('Most likely');
  });

  test('a follow-up after a failed reasoner explains the degradation, not a fabrication', async () => {
    const failing = deps({
      reasoner: {
        name: 'failing',
        model: 'failing-1',
        reason: async () => {
          throw new Error('nope');
        },
      },
    });
    await handleMessage(failing, inbound('investigate INC-481', 'c:1'));

    const why = await handleMessage(failing, inbound('why', 'c:1'));

    expect(why.text).not.toMatch(/sorry|went wrong/i);
  });

  test('never rethrows, whatever happens', async () => {
    const broken = deps({
      collectorsFor: () => {
        throw new Error('boom');
      },
    });

    expect(handleMessage(broken, inbound('investigate INC-481'))).resolves.toBeDefined();
  });
});

describe('one handler across channels', () => {
  test('produces the same answer whichever channel it arrives on', async () => {
    // Invariant 6, as a test rather than a claim. Duplicating a handler per platform explicitly
    // does not count for this challenge.
    const viaTelegram = await handleMessage(
      shared,
      inbound('investigate INC-481', 'c:1', 'telegram'),
    );
    const viaSlack = await handleMessage(deps(), inbound('investigate INC-481', 'c:2', 'slack'));

    expect(viaSlack.text).toBe(viaTelegram.text);
    expect(viaSlack.blocks).toEqual(viaTelegram.blocks);
  });
});

describe('follow-ups reuse the report that was shown', () => {
  test('"why" explains the same conclusion, without asking the model again', async () => {
    // Re-reasoning per follow-up took 40 seconds on a real Telegram thread and, worse, is not
    // deterministic: the model can return different hypotheses, so "why" would explain a
    // conclusion the user was never shown.
    let reasonCalls = 0;
    const counting = deps({
      reasoner: {
        name: 'counting',
        model: 'counting-1',
        reason: async () => {
          reasonCalls++;
          return {
            summary: `run ${reasonCalls} [E1]`,
            hypotheses: [
              {
                statement: `conclusion from run ${reasonCalls}`,
                confidence: 0.9,
                citations: [{ label: 'E1', stance: 'supports' as const }],
              },
            ],
            suggestedQuestions: [],
          };
        },
      },
    });

    const report = await handleMessage(counting, inbound('investigate INC-481', 'c:1'));
    const why = await handleMessage(counting, inbound('why', 'c:1'));

    expect(reasonCalls).toBe(1);
    expect(report.text).toContain('conclusion from run 1');
    expect(why.text).toContain('conclusion from run 1');
  });

  test('"show" reads the stored report rather than reasoning again', async () => {
    let reasonCalls = 0;
    const counting = deps({
      reasoner: {
        name: 'counting',
        model: 'counting-1',
        reason: async () => {
          reasonCalls++;
          return {
            summary: 'x [E1]',
            hypotheses: [
              {
                statement: 'y',
                confidence: 0.9,
                citations: [{ label: 'E1', stance: 'supports' as const }],
              },
            ],
            suggestedQuestions: [],
          };
        },
      },
    });

    await handleMessage(counting, inbound('investigate INC-481', 'c:1'));
    await handleMessage(counting, inbound('show deploy', 'c:1'));

    expect(reasonCalls).toBe(1);
  });
});

describe('a failed reasoner must not be permanent', () => {
  /** A reasoner that fails until `fail` is cleared — a rate limit, not a broken deployment. */
  function flaky() {
    const state = { fail: true };
    const real = defaultRecordedReasoner();
    const subject = deps({
      reasoner: {
        name: 'flaky',
        model: 'flaky-1',
        reason: async (request) => {
          if (state.fail) throw new Error('429 quota exceeded (transient)');
          return await real.reason(request);
        },
      },
    });
    return { deps: subject, state };
  }

  test('re-asking after the rate limit clears gives a real report', async () => {
    // A 429 is a normal Tuesday on a free tier. Storing the degraded report would make a transient
    // outage permanent: `ready` is terminal, so every later ask returns the stored apology and the
    // incident can never be reasoned about again.
    const { deps: subject, state } = flaky();

    const down = await handleMessage(subject, inbound('investigate INC-481', 'c:1'));
    expect(down.text).toContain('could not reason about it');

    state.fail = false;
    const back = await handleMessage(subject, inbound('investigate INC-481', 'c:2'));

    expect(back.text).toContain('Most likely');
    expect(back.text).not.toContain('could not reason about it');
  });

  test('does not persist a report it could not reason about', async () => {
    const { deps: subject } = flaky();

    await handleMessage(subject, inbound('investigate INC-481', 'c:1'));

    const investigation = await subject.store.investigations.findByExternalRef(subject.tenant, {
      system: 'pagerduty',
      id: 'INC-481',
    });
    expect(investigation).toBeDefined();
    if (investigation) {
      expect(await subject.store.reports.findFor(subject.tenant, investigation.id)).toBeUndefined();
    }
  });

  test('does not fingerprint the incident by its own error message', async () => {
    // `similaritySourceText` folds the report summary into the embedding. Indexing "could not
    // reason about it: 429 quota exceeded" would make this incident's nearest neighbour every
    // *other* incident that hit a rate limit, which is a confident, wrong "we have seen this
    // before" — the worst possible answer to that question.
    const indexed: string[] = [];
    const { deps: subject } = flaky();
    const spying: AgentDeps = {
      ...subject,
      embedder: {
        model: 'spy-1',
        minSimilarity: 0.9,
        embed: async (text: string) => {
          indexed.push(text);
          return [1, 0, 0];
        },
      },
    };

    await handleMessage(spying, inbound('investigate INC-481', 'c:1'));

    expect(indexed.length).toBeGreaterThan(0);
    for (const text of indexed) expect(text).not.toContain('could not reason about it');
    // The real fingerprint survives: services and error signatures come off the graph.
    expect(indexed.some((text) => text.includes('payments-api'))).toBe(true);
  });
});
