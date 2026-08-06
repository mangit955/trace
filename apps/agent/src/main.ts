import { CommClient, CommError } from 'caspian-sdk';
import { ACK, attachHandlers, connectChannels } from './caspian.ts';
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

// Caspian knows each channel's etiquette — X's character cap, iMessage's lack of markdown — far
// better than a constant in this repo would, and it stays current without anyone maintaining it.
// Folded into free-form answers only; structured reports are rendered deterministically.
try {
  deps.behaviourGuide = await client.behaviorPrompt();
} catch (error) {
  const detail = error instanceof CommError ? error.detail : String(error);
  console.warn(`[trace] could not fetch channel etiquette, continuing without it: ${detail}`);
}

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

console.log(`[trace] reasoning: ${deps.reasoner.model}`);
console.log('[trace] listening.');

// `ack` covers channels with no typing indicator; Caspian shows a real one where it can. A
// reconstruction takes a few seconds, and silence in that gap reads as a broken bot.
await client.listen({ ack: ACK });
