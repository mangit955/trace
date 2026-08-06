import { describe, expect, test } from 'bun:test';
import { HallucinatedCitationError, UngroundedClaimError } from '../citations.ts';
import { EvidenceNodeId, InvestigationId, newId, OrgId } from '../ids.ts';
import { createHypothesis } from './hypothesis.ts';

const orgId = newId(OrgId);
const investigationId = newId(InvestigationId);
const e1 = newId(EvidenceNodeId);
const e2 = newId(EvidenceNodeId);
const idMap = new Map([
  ['E1', e1],
  ['E2', e2],
]);
const now = new Date('2026-08-06T10:22:00.000Z');

function make(overrides: Partial<Parameters<typeof createHypothesis>[0]> = {}) {
  return createHypothesis({
    orgId,
    investigationId,
    statement: 'The Redis pool max was lowered below steady-state concurrency.',
    confidence: 0.87,
    citations: [{ label: 'E1', stance: 'supports' }],
    idMap,
    model: 'gemini-2.5-flash',
    promptVersion: 'investigate/v1',
    evidenceSeen: [e1, e2],
    now,
    ...overrides,
  });
}

describe('creation', () => {
  test('resolves each citation to the evidence it points at', () => {
    expect(make().citations[0]?.nodeId).toBe(e1);
  });

  test('keeps the label the model used, so the report and the prompt agree', () => {
    expect(make().citations[0]?.label).toBe('E1');
  });

  test('records the confidence the model reported', () => {
    expect(make().confidence).toBe(0.87);
  });
});

describe('grounding', () => {
  test('rejects a hypothesis citing evidence that does not exist', () => {
    expect(() => make({ citations: [{ label: 'E9', stance: 'supports' }] })).toThrow(
      HallucinatedCitationError,
    );
  });

  test('rejects a hypothesis citing nothing', () => {
    expect(() => make({ citations: [] })).toThrow(UngroundedClaimError);
  });

  test('rejects a hypothesis with only contradicting evidence', () => {
    // Evidence against a theory is not evidence for it. Without this, the model could assert a
    // cause while every citation it offered argued the opposite.
    expect(() => make({ citations: [{ label: 'E1', stance: 'contradicts' }] })).toThrow(
      /supporting/i,
    );
  });

  test('accepts contradicting evidence alongside supporting evidence', () => {
    // Recording what argues against the leading theory is the point — it is what lets an engineer
    // judge the conclusion rather than take it on trust.
    const hypothesis = make({
      citations: [
        { label: 'E1', stance: 'supports' },
        { label: 'E2', stance: 'contradicts' },
      ],
    });

    expect(hypothesis.citations.filter((c) => c.stance === 'contradicts')).toHaveLength(1);
  });
});

describe('validation', () => {
  test.each([[-0.1], [1.1]])('rejects a confidence of %p', (confidence) => {
    expect(() => make({ confidence })).toThrow();
  });

  test.each([[0], [1]])('accepts a confidence of %p', (confidence) => {
    expect(() => make({ confidence })).not.toThrow();
  });

  test('rejects an empty statement', () => {
    expect(() => make({ statement: '  ' })).toThrow(/statement/i);
  });
});

describe('reproducibility', () => {
  test('records the model and prompt version that produced it', () => {
    const hypothesis = make();
    expect(hypothesis.model).toBe('gemini-2.5-flash');
    expect(hypothesis.promptVersion).toBe('investigate/v1');
  });

  test('records the exact evidence set the model was shown', () => {
    // Six months later, "why did it conclude that?" is only answerable if we know what it saw —
    // including the evidence it chose not to cite.
    expect(make().evidenceSeen).toEqual([e1, e2]);
  });
});
