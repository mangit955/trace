import { describe, expect, test } from 'bun:test';
import {
  assertGrounded,
  extractCitationLabels,
  HallucinatedCitationError,
  UngroundedClaimError,
  validateCitations,
} from './citations.ts';
import { EvidenceNodeId, newId } from './ids.ts';

const e1 = newId(EvidenceNodeId);
const e2 = newId(EvidenceNodeId);
const idMap = new Map([
  ['E1', e1],
  ['E2', e2],
]);

describe('validateCitations', () => {
  test('resolves labels to the evidence they point at', () => {
    expect(validateCitations(['E1', 'E2'], idMap)).toEqual(
      new Map([
        ['E1', e1],
        ['E2', e2],
      ]),
    );
  });

  test('rejects a citation to evidence that does not exist', () => {
    // This is the mechanism that stops the model inventing support for a conclusion. Not the
    // prompt wording — this check.
    expect(() => validateCitations(['E1', 'E9'], idMap)).toThrow(HallucinatedCitationError);
  });

  test('names every fabricated citation, not just the first', () => {
    const attempt = () => validateCitations(['E7', 'E8', 'E9'], idMap);
    expect(attempt).toThrow(/E7/);
    expect(attempt).toThrow(/E8/);
    expect(attempt).toThrow(/E9/);
  });

  test('reports which labels were actually available, so a failure is debuggable', () => {
    expect(() => validateCitations(['E9'], idMap)).toThrow(/E1/);
  });

  test('tolerates lowercase, since models are inconsistent about it', () => {
    expect(validateCitations(['e1'], idMap).get('E1')).toBe(e1);
  });

  test('ignores duplicate citations of the same evidence', () => {
    expect(validateCitations(['E1', 'E1'], idMap).size).toBe(1);
  });

  test.each([['X1'], ['E'], [''], ['E1a'], ['1']])('rejects the malformed label %p', (label) => {
    expect(() => validateCitations([label], idMap)).toThrow();
  });

  test('rejects a claim citing nothing at all', () => {
    // A conclusion with no evidence is a guess, which is the one thing this system exists to
    // prevent. It must fail loudly rather than pass through as an unsupported assertion.
    expect(() => validateCitations([], idMap)).toThrow(UngroundedClaimError);
  });
});

describe('extractCitationLabels', () => {
  test('finds bracketed references in prose', () => {
    expect(extractCitationLabels('The deploy [E1] preceded the error spike [E2].')).toEqual([
      'E1',
      'E2',
    ]);
  });

  test('returns each label once, in order of first appearance', () => {
    expect(extractCitationLabels('[E2] then [E1] then [E2] again')).toEqual(['E2', 'E1']);
  });

  test('normalises case', () => {
    expect(extractCitationLabels('see [e3]')).toEqual(['E3']);
  });

  test('ignores prose that merely looks like a citation', () => {
    // Without requiring brackets, an m5.E2 instance type or a sentence about "E2 encryption"
    // would silently register as evidence.
    expect(extractCitationLabels('the E2 instance and Section E4 are unrelated')).toEqual([]);
  });

  test('finds nothing in text with no citations', () => {
    expect(extractCitationLabels('It was probably the database.')).toEqual([]);
  });
});

describe('assertGrounded', () => {
  test('accepts prose whose citations all resolve', () => {
    expect(() => assertGrounded('Caused by the deploy [E1].', idMap)).not.toThrow();
  });

  test('rejects prose citing evidence that was never collected', () => {
    expect(() => assertGrounded('Caused by the rollback [E9].', idMap)).toThrow(
      HallucinatedCitationError,
    );
  });

  test('rejects a confident-sounding claim that cites nothing', () => {
    expect(() => assertGrounded('It was definitely the Redis pool.', idMap)).toThrow(
      UngroundedClaimError,
    );
  });
});
