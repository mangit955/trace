import { describe, expect, test } from 'bun:test';
import { fixtureCollectors, INC_481 } from '@trace/collectors/fixtures';
import { InMemoryStore } from '@trace/db';
import { EvidenceKindRegistry, newId, OrgId, registerCoreKinds, systemClock } from '@trace/domain';
import { defaultRecordedReasoner } from '@trace/reasoner';
import { CommClient, type Connection } from 'caspian-sdk';
import { attachHandlers, awaitActive, connectChannels, outboundConnection } from './caspian.ts';
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

/**
 * The install path — the one part of the agent that had no test at all.
 *
 * Slack is not `connectTelegram` with a different name: it is an OAuth install that returns a
 * connection a human has not approved yet. Everything below exists because that difference was
 * being ignored — the same `connect → log "connected" → use connections[0]` shape as Telegram, on
 * something that is not connected.
 *
 * The wire shapes asserted here were read out of `caspian-sdk/dist/index.js`, not assumed. The
 * install body is **snake_case** (`display_name`, `icon_url`); guessing `displayName` would have
 * produced a test that passes against my belief and fails against the gateway.
 */
function connectionsGateway(route: (call: Recorded) => { status?: number; json: unknown }) {
  const calls: Recorded[] = [];

  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    const call = { url, method, body };
    calls.push(call);

    const reply = route(call);
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  };

  const client = new CommClient({
    apiKey: 'test-key',
    baseUrl: 'https://gateway.test',
    fetch: impl as unknown as typeof fetch,
  });

  return { client, calls };
}

/**
 * Captures what the operator would see.
 *
 * The console *is* the interface for the install flow — an authorize_url nobody prints is an
 * agent nobody can connect — so these lines are asserted rather than allowed to scroll past.
 */
function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const [log, error] = [console.log, console.error];
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  console.log = record;
  console.error = record;

  return run()
    .then((result) => ({ result, lines }))
    .finally(() => {
      console.log = log;
      console.error = error;
    });
}

const ACTIVE_TELEGRAM = { id: 'conn-tg', status: 'active', channel: 'telegram' };

describe('connecting channels', () => {
  test('surfaces the authorize_url that Slack needs a human to click', async () => {
    const { client } = connectionsGateway(() => ({
      json: {
        id: 'conn-slack',
        status: 'pending',
        channel: 'slack',
        authorize_url: 'https://slack.test/oauth',
      },
    }));

    const { result, lines } = await captureLogs(() => connectChannels(client, { slack: true }));

    expect(result[0]?.authorize_url).toBe('https://slack.test/oauth');
    expect(lines.join('\n')).toContain('https://slack.test/oauth');
  });

  test('prints the connection id to save, so the next boot does not mint a second install', async () => {
    // Without this, every `bun start` creates another pending connection and another dead
    // authorize_url, and the workspace accumulates orphan installs.
    const { client } = connectionsGateway(() => ({
      json: {
        id: 'conn-slack',
        status: 'pending',
        channel: 'slack',
        authorize_url: 'https://slack.test/oauth',
      },
    }));

    const { lines } = await captureLogs(() => connectChannels(client, { slack: true }));

    expect(lines.join('\n')).toContain('SLACK_CONNECTION_ID=conn-slack');
  });

  test('re-installs when the saved connection was never approved', async () => {
    /**
     * Found by running it, not by reading it.
     *
     * `getConnection` returns no `authorize_url` — only the install call does. So a
     * `SLACK_CONNECTION_ID` saved from an install nobody finished pins the agent to a connection
     * that can never be completed: every start reports "awaiting approval" and there is no URL
     * anywhere to click. This session hit exactly that, and the only way out was editing `.env` by
     * hand, which is not a thing an operator should have to deduce.
     *
     * Re-installing while pending is not the orphan-install problem the id was saved to prevent:
     * that was about minting a new connection when a *working* one existed.
     */
    const { client, calls } = connectionsGateway((call) =>
      call.method === 'GET'
        ? { json: { id: 'conn-stale', status: 'pending_oauth', channel: 'slack' } }
        : {
            json: {
              id: 'conn-fresh',
              status: 'pending_oauth',
              channel: 'slack',
              authorize_url: 'https://slack.test/fresh',
            },
          },
    );

    const { result, lines } = await captureLogs(() =>
      connectChannels(client, { slack: true, slackConnectionId: 'conn-stale' }),
    );

    expect(calls.some((call) => call.url.includes('/slack/install'))).toBe(true);
    expect(result[0]?.id).toBe('conn-fresh');
    expect(lines.join('\n')).toContain('https://slack.test/fresh');
    // The operator has to be told the id moved, or they reuse the stale one forever.
    expect(lines.join('\n')).toContain('SLACK_CONNECTION_ID=conn-fresh');
  });

  test('brands the install so Slack posts as Trace, not as the shared Caspian app', async () => {
    const { client, calls } = connectionsGateway(() => ({
      json: { id: 'conn-slack', status: 'pending', channel: 'slack' },
    }));

    await captureLogs(() =>
      connectChannels(client, {
        slack: true,
        slackDisplayName: 'Trace',
        slackIconUrl: 'https://trace.test/icon.png',
      }),
    );

    const install = calls.find((call) => call.url.endsWith('/v1/connections/slack/install'));
    expect(install?.body?.['display_name']).toBe('Trace');
    expect(install?.body?.['icon_url']).toBe('https://trace.test/icon.png');
  });

  test('reuses an approved connection instead of installing again', async () => {
    const { client, calls } = connectionsGateway(() => ({
      json: { id: 'conn-slack', status: 'active', channel: 'slack' },
    }));

    const { result } = await captureLogs(() =>
      connectChannels(client, { slack: true, slackConnectionId: 'conn-slack' }),
    );

    expect(result[0]?.status).toBe('active');
    expect(calls.some((call) => call.url.includes('/slack/install'))).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/v1/connections/conn-slack'))).toBe(true);
  });

  test('keeps Telegram working when the Slack install fails', async () => {
    // A channel that will not connect is a degraded agent, not a dead one.
    const { client } = connectionsGateway((call) =>
      call.url.includes('slack')
        ? { status: 500, json: { detail: 'slack is down' } }
        : { json: ACTIVE_TELEGRAM },
    );

    const { result, lines } = await captureLogs(() =>
      connectChannels(client, { telegramBotToken: 'tok', slack: true }),
    );

    expect(result.map((connection) => connection.channel)).toEqual(['telegram']);
    expect(lines.join('\n')).toContain('slack is down');
  });
});

describe('choosing the connection to page on-call from', () => {
  test('prefers an active connection over one still awaiting approval', () => {
    // `connections[0]` would have picked Slack here and paged nobody, silently.
    const pendingSlack = { id: 'conn-slack', status: 'pending', channel: 'slack' };

    expect(outboundConnection([pendingSlack, ACTIVE_TELEGRAM])?.id).toBe('conn-tg');
  });

  test('falls back to whatever there is, rather than refusing to page at all', () => {
    const pendingSlack = { id: 'conn-slack', status: 'pending', channel: 'slack' };

    expect(outboundConnection([pendingSlack])?.id).toBe('conn-slack');
  });

  test('is undefined when nothing connected', () => {
    expect(outboundConnection([])).toBeUndefined();
  });
});

describe('waiting for a human to approve the install', () => {
  const pending: Connection = { id: 'conn-slack', status: 'pending', channel: 'slack' };

  test('resolves once the install has been approved', async () => {
    let polls = 0;
    const { client } = connectionsGateway(() => {
      polls += 1;
      return {
        json: { id: 'conn-slack', status: polls < 3 ? 'pending' : 'active', channel: 'slack' },
      };
    });

    const { result, lines } = await captureLogs(() =>
      awaitActive(client, pending, { pollIntervalMs: 0, attempts: 10 }),
    );

    expect(result?.status).toBe('active');
    expect(lines.join('\n')).toMatch(/slack is live/i);
  });

  test('gives up rather than polling forever', async () => {
    const { client, calls } = connectionsGateway(() => ({ json: pending }));

    const { result } = await captureLogs(() =>
      awaitActive(client, pending, { pollIntervalMs: 0, attempts: 3 }),
    );

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  test('stops early when the gateway says the install failed', async () => {
    const { client, calls } = connectionsGateway(() => ({
      json: { id: 'conn-slack', status: 'failed', channel: 'slack', error: 'workspace declined' },
    }));

    const { result, lines } = await captureLogs(() =>
      awaitActive(client, pending, { pollIntervalMs: 0, attempts: 10 }),
    );

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(lines.join('\n')).toContain('workspace declined');
  });

  test('a gateway that is down ends the wait instead of killing the process', async () => {
    const { client } = connectionsGateway(() => ({ status: 500, json: { detail: 'nope' } }));

    const { result } = await captureLogs(() =>
      awaitActive(client, pending, { pollIntervalMs: 0, attempts: 3 }),
    );

    expect(result).toBeUndefined();
  });
});
