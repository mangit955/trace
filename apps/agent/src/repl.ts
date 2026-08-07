import { handleMessage } from './handler.ts';
import { buildDeps, openStore } from './wiring.ts';

/**
 * Trace in a terminal — `bun run dev`.
 *
 * This exists so a reviewer can try the agent with **no credentials at all**: no Caspian key, no
 * LLM key, no database, no Docker. It is not a mock of the agent, it is the agent: every line typed
 * here goes through exactly the same `handleMessage` that Telegram and Slack messages go through,
 * so anything that works in this REPL works on a real channel.
 *
 * That shared path is also what makes "one handler across channels" demonstrable rather than
 * asserted — a second implementation for local use would defeat the point entirely.
 */

// In-memory unless DATABASE_URL is set, in which case this REPL is also how you check the
// Postgres path by hand.
const deps = buildDeps(process.env, await openStore());
const conversationId = `local:${Date.now()}`;

console.log('Trace — incident investigator. I reconstruct incidents; I do not fix them.');
console.log(`Reasoning: ${deps.reasoner.model}`);
console.log(`Storage:   ${process.env['DATABASE_URL'] ? 'postgres' : 'in-memory'}`);
console.log('Try: investigate INC-481   then: why   ·   Ctrl-C to quit\n');

const prompt = '> ';
process.stdout.write(prompt);

for await (const line of console) {
  const text = line.trim();
  if (text === 'exit' || text === 'quit') break;

  const reply = await handleMessage(deps, {
    text,
    // A channel name like any other. The handler must not care, and does not.
    channel: 'terminal',
    conversationId,
  });

  console.log(`\n${reply.text}\n`);

  // The blocks a real channel would render natively. Shown as a count rather than dumped, so the
  // terminal stays readable while making it obvious they are being produced.
  if (reply.blocks?.length) {
    console.log(`[${reply.blocks.length} rich blocks would render natively on Slack/Telegram]\n`);
  }

  process.stdout.write(prompt);
}
