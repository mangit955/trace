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
import type { ReasonedOutput, Reasoner, ReasoningRequest } from './reasoner.ts';
import { NoRecordingError, recordedReasoner } from './recorded.ts';
import { fallbackReasoner, selectReasoner } from './select.ts';

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

const response: ReasonedOutput = {
  summary: 'From the recording [E1].',
  hypotheses: [
    {
      statement: 'It was the deploy.',
      confidence: 0.8,
      citations: [{ label: 'E1', stance: 'supports' }],
    },
  ],
  suggestedQuestions: [],
};

const recorded = recordedReasoner([
  {
    externalId: 'INC-481',
    model: 'gemini-2.5-flash',
    promptVersion: 'investigate/v1',
    capturedAt: '2026-08-06T11:00:00.000Z',
    response,
  },
]);

function failing(error: Error): Reasoner {
  return {
    name: 'gemini',
    model: 'gemini-2.5-flash',
    reason: async () => {
      throw error;
    },
  };
}

const working: Reasoner = {
  name: 'gemini',
  model: 'gemini-2.5-flash',
  reason: async () => ({ ...response, summary: 'Live reasoning [E1].' }),
};

describe('fallbackReasoner', () => {
  test('uses the primary while it works', async () => {
    const subject = fallbackReasoner(working, recorded);

    expect((await subject.reason(requestFor('INC-481'))).summary).toBe('Live reasoning [E1].');
  });

  test('falls back when the primary is rate limited, so the investigation still completes', async () => {
    // Rate limits are the normal condition of a free tier. An investigation that dies because the
    // quota ran out is the worst outcome available at 3am.
    const subject = fallbackReasoner(failing(new Error('Gemini returned 429')), recorded);

    expect((await subject.reason(requestFor('INC-481'))).summary).toBe('From the recording [E1].');
  });

  test('reports the model that actually answered', async () => {
    const subject = fallbackReasoner(failing(new Error('Gemini returned 429')), recorded);
    await subject.reason(requestFor('INC-481'));

    expect(subject.model).toBe('gemini-2.5-flash (replayed)');
  });

  test('raises the original failure when the fallback has nothing for that incident', async () => {
    // Better a failed investigation than one answered with another incident's reasoning.
    const subject = fallbackReasoner(failing(new Error('Gemini returned 429')), recorded);

    expect(subject.reason(requestFor('INC-999'))).rejects.toBeInstanceOf(NoRecordingError);
  });
});

describe('selectReasoner', () => {
  test('replays recordings when no key is configured', () => {
    expect(selectReasoner({}, { recorded }).name).toBe('recorded');
  });

  test('reasons live, with the recording behind it, once a key is configured', () => {
    const subject = selectReasoner({ GEMINI_API_KEY: 'test-key' }, { recorded });

    expect(subject.name).toBe('gemini');
  });

  test('honours a model override, so a newer model needs no code change', () => {
    const subject = selectReasoner(
      { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-3.6-flash' },
      { recorded },
    );

    expect(subject.model).toBe('gemini-3.6-flash');
  });
});
