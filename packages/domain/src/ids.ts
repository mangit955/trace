import { z } from 'zod';

/**
 * Branded identifiers.
 *
 * Every id in the domain is a UUID, which means nothing stops you from passing an
 * InvestigationId where an OrgId is expected — they are structurally identical strings.
 * Branding makes that a compile error. This matters most in the repository layer, where a
 * transposed id argument is a cross-tenant data leak rather than a crash.
 */

export const OrgId = z.uuid().brand<'OrgId'>();
export type OrgId = z.infer<typeof OrgId>;

export const InvestigationId = z.uuid().brand<'InvestigationId'>();
export type InvestigationId = z.infer<typeof InvestigationId>;

export const EvidenceNodeId = z.uuid().brand<'EvidenceNodeId'>();
export type EvidenceNodeId = z.infer<typeof EvidenceNodeId>;

/** Mints a new id of the given branded type. */
export function newId<T extends z.ZodType<string, string>>(schema: T): z.infer<T> {
  return schema.parse(uuidv7());
}

let lastMs = -1;
let counter = 0;

/**
 * RFC 9562 UUIDv7 — a time-ordered UUID.
 *
 * Chosen over v4 because `evidence_nodes` is append-heavy and random v4 keys scatter B-tree
 * inserts across the whole index, forcing page splits and bloating the working set. v7 ids sort
 * by creation time, so inserts stay at the right edge of the index.
 *
 * The 12-bit `rand_a` field is used as a sub-millisecond counter so ids minted within the same
 * millisecond still sort in generation order. If the clock steps backwards (NTP correction), we
 * hold the last timestamp and keep incrementing rather than emitting ids that sort into the past.
 */
export function uuidv7(): string {
  let ms = Date.now();

  if (ms > lastMs) {
    lastMs = ms;
    counter = 0;
  } else {
    counter++;
    if (counter > 0xfff) {
      // Counter exhausted within one millisecond: borrow from the future to stay monotonic.
      lastMs += 1;
      counter = 0;
    }
    ms = lastMs;
  }

  const timestampHex = ms.toString(16).padStart(12, '0');
  const versionAndCounterHex = (0x7000 | counter).toString(16).padStart(4, '0');

  let randomHex = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
    randomHex += byte.toString(16).padStart(2, '0');
  }
  // Force the two most-significant bits of rand_b to 0b10 (the RFC 9562 variant).
  const variantByte = (Number.parseInt(randomHex.slice(0, 2), 16) & 0x3f) | 0x80;
  randomHex = variantByte.toString(16).padStart(2, '0') + randomHex.slice(2);

  return [
    timestampHex.slice(0, 8),
    timestampHex.slice(8, 12),
    versionAndCounterHex,
    randomHex.slice(0, 4),
    randomHex.slice(4, 16),
  ].join('-');
}
