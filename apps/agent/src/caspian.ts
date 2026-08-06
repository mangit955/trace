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

/** What the agent says the instant a message lands, on channels with no typing indicator. */
const ACK = 'On it — reconstructing the incident…';

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
    const connection = await connect('slack', () => client.installSlack());
    if (connection) {
      connections.push(connection);
      // Slack's install is an OAuth flow: the connection is not live until a human approves it.
      if (connection.authorize_url) {
        console.log(`[trace] Slack needs approval — open: ${connection.authorize_url}`);
      }
    }
  }

  return connections;
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
