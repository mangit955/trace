import {
  AccountRequiredError,
  type CommClient,
  CommError,
  type Connection,
  InsufficientCreditError,
} from 'caspian-sdk';
import { type AgentDeps, handleMessage } from './handler.ts';
import type { InboundMessage } from './message.ts';

/**
 * Wiring Trace to Caspian.
 *
 * Everything channel-specific stops here. `onMessage` normalises whatever arrived into an
 * `InboundMessage` and hands it to the one handler; `onInteraction` does the same for button taps.
 * Adding WhatsApp or Discord later is a `connectX` call in `connectChannels` and nothing else —
 * which is the whole point of Caspian, and the reason there is no per-platform handler here.
 */

/**
 * What the agent says the instant a message lands, before the handler has run.
 *
 * Caspian sends this on *every* inbound message, so it has to be true of every one. It said
 * "reconstructing the incident…" until a real `/start` on Telegram was answered with it — nothing
 * was being reconstructed, and the bot's first words to its first user were a small lie. It stays
 * because a reconstruction takes several seconds and silence reads as a broken bot, but it now
 * promises only what it can keep.
 */
const ACK = 'On it, one moment…';

export function attachHandlers(client: CommClient, deps: AgentDeps): void {
  client.onMessage(async (message) => {
    const inbound: InboundMessage = {
      text: message.text,
      channel: message.channel,
      conversationId: message.conversationId,
      sender: message.sender,
    };

    const reply = await handleMessage(deps, inbound);

    // `html` is deliberately null: Trace's output is plain prose plus provider-neutral blocks, and
    // Caspian renders those natively per channel.
    await message.reply(reply.text, null, reply.blocks ?? null);
  });

  /**
   * Button taps, from every channel that has buttons.
   *
   * The value carried by the button is the same text a user could have typed, so a tap and a
   * message take the identical path through the handler. Anything else would be a second, quietly
   * diverging implementation of the same intents.
   */
  client.onInteraction(async (interaction) => {
    // Nullable upstream: a tap on a channel that cannot tell us the thread has nowhere to reply to.
    if (!interaction.conversationId) return;

    const reply = await handleMessage(deps, {
      text: interaction.value,
      channel: 'interaction',
      conversationId: interaction.conversationId,
      sender: interaction.sender,
    });

    await interaction.reply(reply.text, null, reply.blocks ?? null);
  });
}

/**
 * Caspian's own etiquette for a channel, fetched once per channel and kept.
 *
 * `channelGuide()` returns the real rules — that Slack renders mrkdwn rather than markdown, that
 * Telegram wants short and personal — and Caspian keeps them current. Encoding them here would
 * mean maintaining a copy that silently drifts as channels change.
 *
 * Memoised because the guidance is stable for the life of the process, and a network round trip on
 * every message during an incident is exactly the wrong time to spend one. A failure is not worth
 * failing a reply over: the answer is simply written without channel-specific advice.
 */
export function channelGuideSupplier(
  client: CommClient,
): (channel: string) => Promise<string | undefined> {
  const cache = new Map<string, Promise<string | undefined>>();

  return (channel: string) => {
    const cached = cache.get(channel);
    if (cached) return cached;

    const pending = client
      .channelGuide(channel)
      // The gateway returns an empty guide for channels it has nothing specific to say about, and
      // an empty instruction block in a prompt is noise.
      .then((guide) => (guide.trim().length > 0 ? guide : undefined))
      .catch(() => undefined);

    cache.set(channel, pending);
    return pending;
  };
}

export interface ChannelConfig {
  telegramBotToken?: string | undefined;
  slack?: boolean;
  /**
   * An already-approved Slack connection, from a previous install.
   *
   * Slack is not a token you hold, it is an OAuth grant a human clicked once. Without somewhere to
   * remember which connection that produced, every start would mint a *new* pending connection and
   * print a *new* authorize_url — the workspace collects orphan installs, and the one line that
   * matters at first boot becomes noise that never stops.
   */
  slackConnectionId?: string | undefined;
  slackDisplayName?: string | undefined;
  slackIconUrl?: string | undefined;
}

/**
 * Connects whichever channels are configured.
 *
 * Each is optional and independent: a deployment with only a Telegram token is a working agent, and
 * failing to connect one channel never prevents another from working.
 */
export async function connectChannels(
  client: CommClient,
  config: ChannelConfig,
): Promise<Connection[]> {
  const connections: Connection[] = [];

  if (config.telegramBotToken) {
    const connection = await connect('telegram', () =>
      client.connectTelegram({ botToken: config.telegramBotToken as string }),
    );
    if (connection) connections.push(connection);
  }

  if (config.slack) {
    const saved = config.slackConnectionId
      ? await connect('slack', () => client.getConnection(config.slackConnectionId as string))
      : undefined;

    /**
     * A saved install that was never approved is a dead end, not a head start.
     *
     * `getConnection` returns no `authorize_url` — only the install call does — so pinning to a
     * connection stuck at `pending_oauth` leaves the operator reading "awaiting approval" forever
     * with no URL anywhere to click. Minting a fresh one is the only way back, and it is not the
     * orphan-install problem `slackConnectionId` exists to prevent: that is about re-installing
     * over a connection that *works*.
     */
    const usable = saved?.status === 'active';
    if (saved && !usable) {
      console.log(
        `[trace] the saved Slack install (${saved.id}) was never approved — starting a fresh one.`,
      );
    }

    const connection = usable
      ? saved
      : await connect('slack', () =>
          client.installSlack({
            // Branded, so Trace answers under one identity everywhere rather than under the
            // gateway's shared app on Slack and its own name on Telegram.
            ...(config.slackDisplayName ? { displayName: config.slackDisplayName } : {}),
            ...(config.slackIconUrl ? { iconUrl: config.slackIconUrl } : {}),
          }),
        );

    if (connection) {
      connections.push(connection);

      // Slack's install is an OAuth flow: the connection is not live until a human approves it.
      if (connection.authorize_url) {
        console.log(`[trace] Slack needs approval — open: ${connection.authorize_url}`);
      }
      if (!usable) {
        console.log(
          `[trace] then save it so the next start reuses this install: SLACK_CONNECTION_ID=${connection.id}`,
        );
      }
    }
  }

  return connections;
}

/**
 * Which connection proactive outreach goes out on.
 *
 * Anything not `active` cannot deliver — a Slack install nobody has approved will accept an
 * `initiate()` and page nobody — so an active connection wins regardless of order. This used to be
 * `connections[0]`, which is correct exactly while Telegram happens to be listed first.
 *
 * The fallback is deliberate: with only a pending connection, attempting the page and failing
 * loudly beats deciding in advance not to try.
 */
export function outboundConnection(connections: readonly Connection[]): Connection | undefined {
  return connections.find((connection) => connection.status === 'active') ?? connections[0];
}

export interface AwaitActiveOptions {
  pollIntervalMs?: number;
  attempts?: number;
}

/**
 * Polls an OAuth connection until the human on the other end has approved it.
 *
 * `installSlack()` does not go through the SDK's own provisioning wait — it posts once and returns
 * whatever the gateway currently says — so nothing else notices the moment the install goes live.
 * Without this, the operator's only signal is a startup line saying `pending`, printed before they
 * had a chance to click, and never corrected.
 *
 * Bounded rather than endless, and its caller does not await it: a human who never clicks must not
 * hold up the channels that *are* connected, and the poll must not outlive the person's attention
 * by hours. A gateway error ends the wait — this is a courtesy, not a critical path.
 *
 * Checked as `status === 'active'` rather than `!== 'pending'` because the gateway's pre-approval
 * label is not documented anywhere; only the approved state is. The live gateway turned out to say
 * `pending_oauth`, which `!== 'pending'` would have read as approved.
 *
 * The default bound is twenty minutes because the thing being waited on is a person: creating a
 * Slack workspace, finding the admin who can approve an app, and clicking through OAuth is not a
 * five-minute errand, and a poller that gives up first reports "never approved" about an install
 * that was.
 */
export async function awaitActive(
  client: Pick<CommClient, 'getConnection'>,
  connection: Connection,
  options: AwaitActiveOptions = {},
): Promise<Connection | undefined> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const attempts = options.attempts ?? 240;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let current: Connection;
    try {
      current = await client.getConnection(connection.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[trace] stopped watching the ${label(connection)} install: ${detail}`);
      return undefined;
    }

    if (current.status === 'active') {
      console.log(`[trace] ${label(connection)} is live — approved and receiving messages.`);
      return current;
    }

    if (current.status === 'failed') {
      console.error(
        `[trace] the ${label(connection)} install failed: ${current.error ?? 'no reason given'}`,
      );
      return undefined;
    }

    if (pollIntervalMs > 0) await Bun.sleep(pollIntervalMs);
  }

  console.error(
    `[trace] gave up waiting for the ${label(connection)} install to be approved. ` +
      'Approve it and start again.',
  );
  return undefined;
}

function label(connection: Connection): string {
  return connection.channel ?? 'channel';
}

/**
 * Connects one channel, turning Caspian's typed failures into something an operator can act on.
 *
 * These are the errors that otherwise read as an opaque stack trace at startup: the distinction
 * between "sign in" and "add credit" is the difference between a two-minute fix and a confused
 * half hour.
 */
async function connect(
  channel: string,
  attempt: () => Promise<Connection>,
): Promise<Connection | undefined> {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof AccountRequiredError) {
      console.error(
        `[trace] ${channel} needs a developer sign-in before it can be used (${error.reason}).\n` +
          '        Run `caspian login`, or call client.login(), then start again.',
      );
    } else if (error instanceof InsufficientCreditError) {
      const balance = error.balanceCents === null ? 'unknown' : `${error.balanceCents}c`;
      console.error(
        `[trace] ${channel} is a paid channel and the balance is too low (balance: ${balance}).\n` +
          '        Top up in the Caspian dashboard, or run with the free channels only.',
      );
    } else if (error instanceof CommError) {
      console.error(`[trace] ${channel} failed to connect: ${error.statusCode} ${error.detail}`);
    } else {
      console.error(`[trace] ${channel} failed to connect:`, error);
    }

    // A channel that will not connect is a degraded agent, not a dead one. Whatever else connected
    // keeps working.
    return undefined;
  }
}

export { ACK };
