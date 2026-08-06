import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  CollectorRunId,
  createEvidenceNode,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  HallucinatedCitationError,
  newId,
  OrgId,
  registerCoreKinds,
  UngroundedClaimError,
} from '@trace/domain';
import { answerQuestion, NoAnswererError } from './answer.ts';
import type { Reasoner } from './reasoner.ts';

const AT = new Date('2026-08-06T10:16:00.000Z');

const registry = new EvidenceKindRegistry();
registerCoreKinds(registry);

const investigation = createInvestigation({
  orgId: newId(OrgId),
  externalRef: { system: 'pagerduty', id: 'INC-481' },
  window: defaultWindowFor(AT),
  now: AT,
});

const graph = buildEvidenceGraph({
  investigationId: investigation.id,
  nodes: [
    createEvidenceNode({
      registry,
      orgId: investigation.orgId,
      investigationId: investigation.id,
      kind: 'alert',
      kindVersion: 1,
      payload: {
        source: 'pagerduty',
        externalId: 'INC-481',
        title: 'Elevated 5xx rate on payments-api',
        severity: 'critical',
        service: 'payments-api',
        firedAt: AT.toISOString(),
      },
      connector: 'pagerduty',
      collectorRunId: newId(CollectorRunId),
      collectedAt: AT,
    }),
  ],
  edges: [],
});

/** A reasoner that can answer, returning whatever prose it is given. */
function answering(prose: string, capture?: (prompt: string) => void): Reasoner {
  return {
    name: 'stub',
    model: 'stub-1',
    reason: async () => {
      throw new Error('not used');
    },
    answer: async (request) => {
      capture?.(request.prompt);
      return prose;
    },
  };
}

/** The recorded reasoner cannot improvise, so it does not implement answer(). */
const cannotAnswer: Reasoner = {
  name: 'recorded',
  model: 'recorded',
  reason: async () => {
    throw new Error('not used');
  },
};

function ask(reasoner: Reasoner, question = 'Was the pool ever raised back?') {
  return answerQuestion({
    question,
    investigation,
    graph,
    registry,
    reasoner,
    behaviourGuide: 'Keep replies under 300 characters.',
  });
}

describe('answerQuestion', () => {
  test('returns prose grounded in the evidence', async () => {
    expect(await ask(answering('No sign of it in the evidence [E1].'))).toBe(
      'No sign of it in the evidence [E1].',
    );
  });

  test('rejects an answer citing evidence that was never collected', async () => {
    // The same gate the report goes through. A conversational answer is still a claim.
    expect(ask(answering('It was the deploy [E99].'))).rejects.toBeInstanceOf(
      HallucinatedCitationError,
    );
  });

  test('rejects an answer that cites nothing at all', async () => {
    // Free-form prose is exactly where an uncited assertion would slip through unnoticed.
    expect(ask(answering('It was obviously the deploy.'))).rejects.toBeInstanceOf(
      UngroundedClaimError,
    );
  });

  test('shows the reasoner the evidence and the question', async () => {
    let prompt = '';
    await ask(
      answering('Yes [E1].', (p) => {
        prompt = p;
      }),
      'Which service alerted?',
    );

    expect(prompt).toContain('Which service alerted?');
    expect(prompt).toContain('Elevated 5xx rate on payments-api');
  });

  test('frames the channel guide as formatting advice, not as instructions to follow', async () => {
    // Caspian's guides are written for the bot *author* and mention SDK calls: Slack's says
    // "`reply()` posts under the user's message". Handed to a model unframed, it treats that as
    // content — a live answer came back beginning with the literal text "reply()".
    let prompt = '';
    await ask(
      answering('Yes [E1].', (p) => {
        prompt = p;
      }),
    );

    expect(prompt).toMatch(/formatting and length|do not follow|never mention/i);
  });

  test('passes the channel behaviour guide through, so etiquette is the channel’s own', async () => {
    let prompt = '';
    await ask(
      answering('Yes [E1].', (p) => {
        prompt = p;
      }),
    );

    expect(prompt).toContain('Keep replies under 300 characters.');
  });

  test('reports plainly when the reasoner cannot answer questions', async () => {
    // With no API key the recorded reasoner replays reports but cannot improvise, and the caller
    // falls back to deterministic help rather than inventing something.
    expect(ask(cannotAnswer)).rejects.toBeInstanceOf(NoAnswererError);
  });
});
