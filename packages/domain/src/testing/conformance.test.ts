import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { EvidenceKindDefinition } from '../registry.ts';
import { assertValidEvidenceKind, MAX_SUMMARY_CHARS } from './conformance.ts';

const payloadSchema = z.object({ service: z.string(), at: z.iso.datetime() });
type Payload = z.infer<typeof payloadSchema>;

const example: Payload = { service: 'payments-api', at: '2026-08-06T10:00:00.000Z' };

function defineKind(
  overrides: Partial<EvidenceKindDefinition<Payload>> = {},
): EvidenceKindDefinition<Payload> {
  return {
    kind: 'deployment',
    version: 1,
    schema: payloadSchema,
    examples: [example],
    identity: (p) => `${p.service}@${p.at}`,
    summarize: (p) => `deployed ${p.service}`,
    timestamps: (p) => ({ occurredAt: new Date(p.at) }),
    sourceUrl: () => 'https://github.com/acme/payments-api/deployments/1',
    ...overrides,
  };
}

describe('a well-formed definition', () => {
  test('passes conformance', () => {
    expect(() => assertValidEvidenceKind(defineKind())).not.toThrow();
  });

  test('passes without the optional sourceUrl', () => {
    const { sourceUrl: _omitted, ...withoutSourceUrl } = defineKind();
    expect(() => assertValidEvidenceKind(withoutSourceUrl)).not.toThrow();
  });
});

describe('naming and versioning', () => {
  test('rejects a malformed kind name', () => {
    expect(() => assertValidEvidenceKind(defineKind({ kind: 'Deployment' }))).toThrow();
  });

  test('rejects a non-positive version', () => {
    expect(() => assertValidEvidenceKind(defineKind({ version: 0 }))).toThrow();
  });
});

describe('examples', () => {
  test('rejects a definition with no examples', () => {
    // Without an example there is nothing to validate the rest of the contract against, and the
    // definition carries no documentation of its own shape.
    expect(() => assertValidEvidenceKind(defineKind({ examples: [] }))).toThrow('example');
  });

  test('rejects an example that violates its own schema', () => {
    const bad = [{ service: 'payments-api' } as unknown as Payload];
    expect(() => assertValidEvidenceKind(defineKind({ examples: bad }))).toThrow();
  });
});

describe('schema strength', () => {
  test('rejects a schema that accepts anything', () => {
    // A z.any() schema would silently defeat boundary validation, letting malformed or hostile
    // collector output through as a well-formed evidence node.
    const permissive = z.any() as unknown as z.ZodType<Payload>;
    expect(() => assertValidEvidenceKind(defineKind({ schema: permissive }))).toThrow('permissive');
  });
});

describe('identity', () => {
  test('rejects an empty identity', () => {
    expect(() => assertValidEvidenceKind(defineKind({ identity: () => '' }))).toThrow('identity');
  });

  test('rejects a non-deterministic identity', () => {
    // Identity is the dedup key. If it is unstable, re-collection duplicates every node.
    let n = 0;
    const unstable = () => `id-${n++}`;
    expect(() => assertValidEvidenceKind(defineKind({ identity: unstable }))).toThrow(
      'deterministic',
    );
  });
});

describe('summarize', () => {
  test('rejects an empty summary', () => {
    expect(() => assertValidEvidenceKind(defineKind({ summarize: () => '' }))).toThrow('summarize');
  });

  test('rejects a summary longer than the cap', () => {
    // Bounded summaries are what stop one chatty collector from consuming the whole prompt budget.
    const huge = () => 'x'.repeat(MAX_SUMMARY_CHARS + 1);
    expect(() => assertValidEvidenceKind(defineKind({ summarize: huge }))).toThrow('exceeds');
  });

  test('rejects a non-deterministic summary', () => {
    let n = 0;
    const unstable = () => `summary ${n++}`;
    expect(() => assertValidEvidenceKind(defineKind({ summarize: unstable }))).toThrow(
      'deterministic',
    );
  });
});

describe('timestamps', () => {
  test('rejects an invalid occurredAt', () => {
    const bad = () => ({ occurredAt: new Date('not a date') });
    expect(() => assertValidEvidenceKind(defineKind({ timestamps: bad }))).toThrow('occurredAt');
  });

  test('rejects an invalid observedAt when present', () => {
    const bad = (p: Payload) => ({
      occurredAt: new Date(p.at),
      observedAt: new Date('not a date'),
    });
    expect(() => assertValidEvidenceKind(defineKind({ timestamps: bad }))).toThrow('observedAt');
  });
});

describe('sourceUrl', () => {
  test('rejects a value that is not a url', () => {
    const bad = () => 'github.com/acme/payments-api';
    expect(() => assertValidEvidenceKind(defineKind({ sourceUrl: bad }))).toThrow('sourceUrl');
  });

  test('accepts undefined, since not all evidence has a deep link', () => {
    expect(() => assertValidEvidenceKind(defineKind({ sourceUrl: () => undefined }))).not.toThrow();
  });
});
