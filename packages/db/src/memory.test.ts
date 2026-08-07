import { describeStoreContract } from './contract.ts';
import { InMemoryStore } from './memory.ts';

/**
 * The in-memory store against the shared repository contract.
 *
 * Nothing here is specific to the implementation — that is the point. The same file drives
 * Postgres in `postgres.test.ts`, so a behaviour one store has and the other does not is a failing
 * test rather than a production surprise.
 */
describeStoreContract('InMemoryStore', { makeStore: () => new InMemoryStore() });
