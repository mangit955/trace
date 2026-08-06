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

    expect(reply.text).toMatch(/investigate|GEMINI_API_KEY/);
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
