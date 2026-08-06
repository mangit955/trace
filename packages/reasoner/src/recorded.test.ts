import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  newId,
  OrgId,
  registerCoreKinds,
  serializeForReasoning,
} from '@trace/domain';
import type { ReasoningRequest } from './reasoner.ts';
import { NoRecordingError, recordedReasoner } from './recorded.ts';

const registry = new EvidenceKindRegistry();
registerCoreKinds(registry);

function requestFor(externalId: string): ReasoningRequest {
  const investigation = createInvestigation({
    orgId: newId(OrgId),
    externalRef: { system: 'pagerduty', id: externalId },
    window: defaultWindowFor(new Date('2026-08-06T10:16:00.000Z')),
    now: new Date('2026-08-06T10:16:00.000Z'),
  });

  return {
    investigation,
    evidence: serializeForReasoning(
      buildEvidenceGraph({ investigationId: investigation.id, nodes: [], edges: [] }),
      registry,
    ),
    gaps: [],
  };
}

const recording = {
  externalId: 'INC-481',
  model: 'gemini-2.5-flash',
  promptVersion: 'investigate/v1',
  capturedAt: '2026-08-06T11:00:00.000Z',
  response: {
    summary: 'The pool was starved [E4].',
    hypotheses: [
      {
        statement: 'REDIS_POOL_MAX was lowered below steady-state concurrency.',
        confidence: 0.9,
        citations: [{ label: 'E4', stance: 'supports' as const }],
      },
    ],
    suggestedQuestions: ['Should REDIS_POOL_MAX be reverted to 50?'],
  },
};

describe('the recorded reasoner', () => {
  const subject = recordedReasoner([recording]);

  test('replays the captured response for the incident it was captured against', async () => {
    expect((await subject.reason(requestFor('INC-481'))).summary).toBe(
      'The pool was starved [E4].',
    );
  });

  test('resolves however the incident id was capitalised', async () => {
    expect((await subject.reason(requestFor('inc-481'))).hypotheses).toHaveLength(1);
  });

  test('refuses to answer for an incident it never saw', async () => {
    // Replaying the wrong incident's reasoning would be worse than failing: the citations would
    // resolve against a different graph, or not at all.
    expect(subject.reason(requestFor('INC-999'))).rejects.toBeInstanceOf(NoRecordingError);
  });

  test('names the model it is replaying, so a report never overstates its provenance', () => {
    expect(subject.model).toBe('gemini-2.5-flash (replayed)');
  });

  test('rejects a recording whose response does not parse', () => {
    // A committed recording is untrusted input like any other; a malformed one should fail at
    // construction, not in the middle of a demo.
    expect(() =>
      recordedReasoner([{ ...recording, response: { summary: 'no hypotheses' } }]),
    ).toThrow(/INC-481/);
  });
});
