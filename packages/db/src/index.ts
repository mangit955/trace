/**
 * `@trace/db` — storage adapters for the domain's repository ports.
 *
 * The in-memory implementations back both the credential-free demo and the entire test suite, so
 * `bun run dev` needs no database and the suite runs in milliseconds. Postgres implementations will
 * satisfy exactly the same interfaces from `@trace/domain`.
 */

export { InMemoryStore } from './memory.ts';
