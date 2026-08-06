import { describe, expect, test } from 'bun:test';
import { fixtureCollectors, INC_481 } from '@trace/collectors/fixtures';
import { InMemoryStore } from '@trace/db';
import { EvidenceKindRegistry, newId, OrgId, registerCoreKinds, systemClock } from '@trace/domain';
import { defaultRecordedReasoner } from '@trace/reasoner';
import { CommClient } from 'caspian-sdk';
import { attachHandlers } from './caspian.ts';
import type { AgentDeps } from './handler.ts';

/**
 * These tests drive the **real** `CommClient` over an injected `fetch`.
 *
 * A hand-rolled fake client would encode my own beliefs about the SDK, so if those beliefs were
 * wrong the fake and the code would be wrong together and this suite would stay green — exactly the
 * failure `CLAUDE.md` warns about, and exactly how a collector name collision survived Phase 2.
 * Driving the real dispatcher over a fake transport tests our *usage* of Caspian instead.
 */

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function deps(): AgentDeps {
  const registry = new EvidenceKindRegistry();
  registerCoreKinds(registry);

  return {
    store: new InMemoryStore(),
    registry,
    reasoner: defaultRecordedReasoner(),
    collectorsFor: () => fixtureCollectors(INC_481),
    seededIncidents: [INC_481],
    tenant: { orgId: newId(OrgId) },
    clock: systemClock,
  };
}

/**
 * A gateway that serves one inbound message event and records what we post back.
 *
 * Two wire details the published summaries got wrong, both found by running this rather than
 * reading about it: the event's message lives at **`data.message`** (an event shaped as
 * `data = message` is silently skipped), and `message.reply()` posts to
 * **`/v1/messages/{id}/reply`** — auto-threaded — not to `/conversations/{id}/messages`, which is
 * what `sendMessage` uses.
 */
function gateway(event: Record<string, unknown>) {
  const calls: Recorded[] = [];
  let served = false;

  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });

    if (url.includes('/events')) {
      // Served once, so a second drain does not redeliver the same message.
      const events = served ? [] : [event];
      served = true;
      return new Response(JSON.stringify(events), { status: 200 });
    }

    return new Response(JSON.stringify({ id: 'msg-out' }), { status: 200 });
  };

  return { fetch: impl as unknown as typeof fetch, calls };
}

function messageEvent(text: string, channel = 'telegram'): Record<string, unknown> {
  return {
    id: 'evt-1',
    seq: 1,
    type: 'message.received',
    occurred_at: '2026-08-06T10:20:00.000Z',
    data: {
      customer_id: 'cus-1',
      agent_id: 'agt-1',
      message: {
        id: 'msg-1',
        conversation_id: 'conv-1',
        connection_id: 'conn-1',
        channel,
        direction: 'inbound',
        sender: { handle: 'dmitri' },
        subject: null,
        text,
        html: null,
        media: [],
        created_at: '2026-08-06T10:20:00.000Z',
      },
    },
  };
}

async function drive(text: string, channel = 'telegram') {
  const { fetch, calls } = gateway(messageEvent(text, channel));
  const client = new CommClient({ apiKey: 'test-key', baseUrl: 'https://gateway.test', fetch });

  attachHandlers(client, deps());
  // Public API: drains everything currently available through the real dispatcher.
  await client.dispatchPending(0);

  // Filtered on /reply specifically: the SDK also POSTs /v1/messages/{id}/typing before the
  // handler runs, which is Caspian showing a typing indicator on our behalf.
  const replies = calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reply'));
  return { calls, replies };
}

describe('the Caspian bootstrap', () => {
  test('routes a real inbound event through our handler and replies', async () => {
    const { replies } = await drive('investigate INC-481');

    expect(replies).toHaveLength(1);
    expect(String(replies[0]?.body?.['text'])).toContain('INC-481');
  });

  test('replies to the message it received, so Caspian threads it automatically', async () => {
    const { replies } = await drive('help');

    expect(replies[0]?.url).toContain('/v1/messages/msg-1/reply');
  });

  test('lets Caspian show the typing indicator rather than hand-rolling one', async () => {
    // The SDK posts a typing indicator itself before the handler runs, on channels that support
    // it. Doing it again here would be duplicated work and a second thing to get wrong.
    const { calls } = await drive('investigate INC-481');

    expect(calls.some((call) => call.url.includes('/typing'))).toBe(true);
  });

  test('sends provider-neutral blocks alongside the text', async () => {
    // Caspian renders these natively per channel, which is why there is one renderer and not one
    // per platform.
    const { replies } = await drive('investigate INC-481');
    const blocks = replies[0]?.body?.['blocks'] as { type: string }[] | undefined;

    expect(blocks?.length).toBeGreaterThan(0);
    expect(blocks?.some((block) => block.type === 'buttons')).toBe(true);
  });

  test('answers Slack with the same handler that answers Telegram', async () => {
    const viaTelegram = await drive('investigate INC-481', 'telegram');
    const viaSlack = await drive('investigate INC-481', 'slack');

    expect(viaSlack.replies[0]?.body?.['text']).toBe(viaTelegram.replies[0]?.body?.['text']);
  });

  test('survives a message that makes the handler fail, and still answers', async () => {
    const { fetch, calls } = gateway(messageEvent('investigate INC-481'));
    const client = new CommClient({ apiKey: 'test-key', baseUrl: 'https://gateway.test', fetch });

    attachHandlers(client, {
      ...deps(),
      collectorsFor: () => {
        throw new Error('collectors are broken');
      },
    });

    await client.dispatchPending(0);

    const replies = calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reply'));
    expect(String(replies[0]?.body?.['text'])).toMatch(/sorry/i);
  });
});
