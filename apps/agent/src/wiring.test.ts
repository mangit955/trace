import { describe, expect, test } from 'bun:test';
import { buildDeps } from './wiring.ts';

/**
 * The composition root.
 *
 * Untested until Phase 5, which is how the tenant identity below survived: with an in-memory store
 * it makes no observable difference, and every other test builds its own deps.
 */

describe('tenant identity', () => {
  test('is stable across restarts, so persisted data is still readable', () => {
    // Two `buildDeps` calls stand in for two runs of the process. A fresh orgId per start is
    // invisible against an empty in-memory store and silently fatal against Postgres: the data is
    // all still there, and every read filters it out.
    const first = buildDeps({});
    const second = buildDeps({});

    expect(second.tenant.orgId).toBe(first.tenant.orgId);
  });

  test('can be pinned by the operator, for a deploy that is not the only one on its database', () => {
    const orgId = '019949d4-1f7e-7000-8000-0000000000ff';

    expect(String(buildDeps({ TRACE_ORG_ID: orgId }).tenant.orgId)).toBe(orgId);
  });

  test('rejects a TRACE_ORG_ID that is not a uuid rather than starting on a bad tenant', () => {
    // Everything is scoped by this value. A typo that silently became a new tenant would read as
    // "all my investigations vanished".
    expect(() => buildDeps({ TRACE_ORG_ID: 'acme' })).toThrow(/TRACE_ORG_ID/);
  });
});
