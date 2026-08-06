import { describe, expect, test } from 'bun:test';
import { EvidenceNodeId, InvestigationId, OrgId, newId, uuidv7 } from './ids.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('id schemas', () => {
  test('parses a valid uuid into a branded id', () => {
    const raw = '018f4a1c-6b2e-7c3d-9e4f-1a2b3c4d5e6f';
    expect(OrgId.parse(raw)).toBe(raw);
  });

  test('rejects a non-uuid string', () => {
    expect(() => OrgId.parse('not-a-uuid')).toThrow();
  });

  test('rejects an empty string', () => {
    expect(() => OrgId.parse('')).toThrow();
  });
});

describe('newId', () => {
  test('generates ids accepted by the schema it is given', () => {
    const id = newId(InvestigationId);
    expect(InvestigationId.parse(id)).toBe(id);
  });

  test('generates a distinct id on each call', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId(EvidenceNodeId)));
    expect(ids.size).toBe(1000);
  });
});

describe('uuidv7', () => {
  test('produces a well-formed uuid string', () => {
    expect(uuidv7()).toMatch(UUID_RE);
  });

  test('sets the version nibble to 7', () => {
    expect(uuidv7()[14]).toBe('7');
  });

  test('sets the RFC 9562 variant bits to 0b10', () => {
    const variant = Number.parseInt(uuidv7()[19] as string, 16);
    expect(variant & 0b1100).toBe(0b1000);
  });

  test('embeds the current unix millisecond timestamp in the first 48 bits', () => {
    const before = Date.now();
    const embedded = Number.parseInt(uuidv7().replace(/-/g, '').slice(0, 12), 16);
    const after = Date.now();

    expect(embedded).toBeGreaterThanOrEqual(before);
    expect(embedded).toBeLessThanOrEqual(after);
  });

  test('sorts lexicographically in generation order', () => {
    // Index locality for append-heavy tables depends on this property holding
    // even for ids minted inside the same millisecond.
    const ids = Array.from({ length: 500 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });
});
