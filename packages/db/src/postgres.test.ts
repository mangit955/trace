import { describe, expect, test } from 'bun:test';
import { InvestigationId, newId, OrgId, type TenantContext } from '@trace/domain';
import { describeStoreContract } from './contract.ts';
import { PostgresStore } from './postgres.ts';

/**
 * The Postgres store against the shared repository contract — the same file the in-memory store is
 * held to, which is the whole point of Phase 5.
 *
 * Skipped unless `TRACE_TEST_DATABASE_URL` is set, so the default suite still runs in milliseconds
 * with no database and no credentials. Bring one up with `docker compose up -d` and run:
 *
 *   TRACE_TEST_DATABASE_URL=postgres://trace:trace@localhost:5433/trace bun test packages/db
 */

const url = process.env['TRACE_TEST_DATABASE_URL'];

if (!url) {
  describe.skip('PostgresStore (set TRACE_TEST_DATABASE_URL to run)', () => {
    test('skipped', () => {});
  });
} else {
  let store: PostgresStore | undefined;

  describeStoreContract('PostgresStore', {
    async makeStore() {
      // One pool for the whole file; the contract mints fresh tenants per test, so isolation comes
      // from the org filter being genuinely exercised rather than from truncating between tests.
      store ??= await PostgresStore.connect(url);
      return store;
    },
    async ensureTenant(ctx: TenantContext) {
      await store?.ensureOrg(ctx.orgId);
    },
    async close() {
      await store?.close();
    },
  });

  // Postgres-only concerns the contract cannot express, because the in-memory store has no schema
  // and no foreign keys.
  describe('PostgresStore schema', () => {
    test('registering an org twice is a no-op, since every startup does it', async () => {
      // If this threw on the second boot the agent simply would not start.
      const connected = await PostgresStore.connect(url);
      const orgId = newId(OrgId);

      await connected.ensureOrg(orgId);
      await expect(connected.ensureOrg(orgId)).resolves.toBeUndefined();
    });

    test('migrating twice applies nothing the second time', async () => {
      // `connect` migrates, and it runs on every start. A migration that re-applied would fail on
      // the second boot at best, and rewrite the schema at worst.
      const { migrate } = await import('./migrate.ts');
      const connected = await PostgresStore.connect(url);

      const second = await migrate(connected.sql);

      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(['0001_core.sql', '0002_vector.sql']);
    });

    test('refuses an investigation for an unregistered tenant rather than inventing one', async () => {
      // The foreign key is the backstop for a misplaced orgId: it fails loudly instead of quietly
      // filing an investigation under a tenant that does not exist.
      const connected = await PostgresStore.connect(url);
      const stranger: TenantContext = { orgId: newId(OrgId) };

      await expect(
        connected.investigations.save(stranger, {
          id: newId(InvestigationId),
          orgId: stranger.orgId,
          externalRef: { system: 'pagerduty', id: 'INC-000' },
          status: 'pending',
          window: { from: new Date('2026-08-06T09:00:00Z'), to: new Date('2026-08-06T10:00:00Z') },
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ).rejects.toThrow();
    });
  });
}
