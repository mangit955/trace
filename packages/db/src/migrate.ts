import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SQL } from 'bun';

/**
 * Migrations, without a migration tool.
 *
 * Numbered `.sql` files applied in order, each recorded in `schema_migrations` so a second run is a
 * no-op. That is the whole feature. A migration framework would add a dependency, a config file and
 * a DSL to a schema that changes rarely and is read far more often than it is written — and the
 * files stay plain SQL a reviewer can read without knowing this repo.
 *
 * Each file runs inside a transaction: Postgres has transactional DDL, so a migration that fails
 * halfway leaves nothing behind and can simply be fixed and re-run. There is no `down`. Rolling a
 * schema backwards on a running incident tool is not something anyone should do at 3am; forward
 * fixes only.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

export interface MigrationResult {
  /** Applied by this run, in order. Empty on an up-to-date database. */
  applied: readonly string[];
  /** Already present. Reported so an operator can see the runner did look. */
  skipped: readonly string[];
}

export async function migrate(sql: SQL, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  await sql`
    create table if not exists schema_migrations (
      version     text primary key,
      applied_at  timestamptz not null default now()
    )
  `;

  const existing = await sql`select version from schema_migrations`;
  const done = new Set<string>(existing.map((row: { version: string }) => row.version));

  // Sorted by filename, which is what makes the numeric prefix meaningful. Anything not ending in
  // `.sql` is ignored, so a stray editor backup cannot become a migration.
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }

    const statements = await Bun.file(join(dir, file)).text();

    try {
      await sql.begin(async (tx: SQL) => {
        // `.simple()` because a migration file holds many statements; the extended protocol Bun
        // uses by default sends one at a time and would reject the file.
        await tx.unsafe(statements).simple();
        await tx`insert into schema_migrations (version) values (${file})`;
      });
    } catch (error) {
      // Bun's error names the failing *statement*, never the file it came from, which is the one
      // thing you need when three migrations have run and the fourth did not.
      const detail = error instanceof Error ? error.message : String(error);
      const hint = /extension "vector"/.test(detail)
        ? '\nThis needs pgvector. The bundled docker-compose.yml uses pgvector/pgvector:pg17; ' +
          'a stock postgres image does not carry the extension.'
        : '';

      throw new Error(`Migration ${file} failed: ${detail}${hint}`);
    }

    applied.push(file);
  }

  return { applied, skipped };
}
