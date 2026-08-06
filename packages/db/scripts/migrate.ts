import { SQL } from 'bun';
import { migrate } from '../src/migrate.ts';

/**
 * `bun run db:migrate` — apply the schema by hand.
 *
 * The agent migrates on startup, so this is not part of the normal path. It exists for the two
 * cases where that is not enough: checking what a migration will do before starting anything, and
 * preparing a database for the contract suite.
 */

const url = process.env['DATABASE_URL'] ?? process.env['TRACE_TEST_DATABASE_URL'];

if (!url) {
  console.error(
    'DATABASE_URL is not set.\n' +
      'Start one with `docker compose up -d`, then:\n' +
      '  DATABASE_URL=postgres://trace:trace@localhost:5433/trace bun run db:migrate',
  );
  process.exit(1);
}

const sql = new SQL(url);

try {
  const { applied, skipped } = await migrate(sql);

  for (const version of skipped) console.log(`  already applied  ${version}`);
  for (const version of applied) console.log(`  applied          ${version}`);

  console.log(
    applied.length === 0 ? 'Schema is up to date.' : `Applied ${applied.length} migration(s).`,
  );
} finally {
  await sql.close();
}
