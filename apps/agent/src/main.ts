import { CommClient } from 'caspian-sdk';
import { type AlertIngress, receiveAlert } from './alert-ingress.ts';
import { recipientsFrom } from './alerts.ts';
import { ACK, attachHandlers, channelGuideSupplier, connectChannels } from './caspian.ts';
import { buildDeps } from './wiring.ts';

/**
 * Trace on Caspian — `bun start`.
 *
 * One client, one handler, every connected channel. The whole runtime is: build the dependencies,
 * connect whatever is configured, attach the handler, listen.
 */

const env = process.env;

if (!env['CASPIAN_API_KEY']) {
  console.error(
    'CASPIAN_API_KEY is not set.\n' +
      'Get one free at https://trycaspianai.com, put it in .env, and run again.\n' +
      'To try Trace with no credentials at all, run: bun run dev',
  );
  process.exit(1);
}

const deps = buildDeps(env);
const client = new CommClient({ apiKey: env['CASPIAN_API_KEY'] });

// Caspian knows each channel's etiquette — that Slack renders mrkdwn rather than markdown, that X
// caps a post at 300 characters — far better than a constant in this repo would, and it stays
// current without anyone maintaining it. Fetched per channel on first use and folded into
// free-form answers only; structured reports are rendered deterministically.
deps.behaviourGuideFor = channelGuideSupplier(client);

const connections = await connectChannels(client, {
  telegramBotToken: env['TELEGRAM_BOT_TOKEN'],
  slack: env['TRACE_ENABLE_SLACK'] === 'true',
});

if (connections.length === 0) {
  console.error(
    'No channels connected. Set TELEGRAM_BOT_TOKEN, or TRACE_ENABLE_SLACK=true, and run again.',
  );
  process.exit(1);
}

for (const connection of connections) {
  console.log(`[trace] ${connection.channel ?? 'channel'} connected (${connection.status})`);
}

attachHandlers(client, deps);

// The only path that can start a conversation with a human, so it is off unless an operator both
// opens a port and names recipients. Absent either, Trace answers when spoken to and nothing more.
const alertPort = Number(env['TRACE_ALERT_PORT'] ?? 0);
const recipients = recipientsFrom(env['TRACE_ONCALL_RECIPIENTS']);

if (alertPort > 0) {
  const first = connections[0];
  const ingress: AlertIngress = {
    agent: deps,
    recipients,
    alreadyNotified: new Set<string>(),
    ...(first ? { outbound: { client, connectionId: first.id } } : {}),
  };

  Bun.serve({
    port: alertPort,
    async fetch(request) {
      if (request.method !== 'POST') return new Response('POST an alert here', { status: 405 });

      try {
        const outcome = await receiveAlert(ingress, await request.json());
        return Response.json(outcome);
      } catch (error) {
        // A malformed webhook is the sender's problem to see, not a reason to fall over.
        const detail = error instanceof Error ? error.message : String(error);
        return Response.json({ error: detail }, { status: 400 });
      }
    },
  });

  console.log(
    `[trace] alert webhook on :${alertPort} — ` +
      (recipients.length > 0
        ? `will page ${recipients.length} recipient(s) once per incident`
        : 'TRACE_ONCALL_RECIPIENTS is unset, so it will investigate but page nobody'),
  );
}

console.log(`[trace] reasoning: ${deps.reasoner.model}`);
console.log('[trace] listening.');

// `ack` covers channels with no typing indicator; Caspian shows a real one where it can. A
// reconstruction takes a few seconds, and silence in that gap reads as a broken bot.
await client.listen({ ack: ACK });
