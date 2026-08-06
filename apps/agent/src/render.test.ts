import { describe, expect, test } from 'bun:test';
import { EvidenceNodeId, HypothesisId, InvestigationId, newId, OrgId } from '@trace/domain';
import type { InvestigationReport } from '@trace/reasoner';
import type { Block } from 'caspian-sdk';
import { renderHelp, renderReasoning, renderReport } from './render.ts';

const orgId = newId(OrgId);
const investigationId = newId(InvestigationId);
const nodeId = newId(EvidenceNodeId);

const report: InvestigationReport = {
  investigationId,
  orgId,
  summary: 'A deploy [E6] preceded a 5xx spike [E1].',
  hypotheses: [
    {
      id: newId(HypothesisId),
      orgId,
      investigationId,
      statement: 'REDIS_POOL_MAX was lowered below steady-state concurrency.',
      confidence: 0.95,
      citations: [{ label: 'E4', nodeId, stance: 'supports' }],
      model: 'gemini-2.5-flash',
      promptVersion: 'investigate/v1',
      evidenceSeen: [nodeId],
      createdAt: new Date('2026-08-06T10:30:00.000Z'),
    },
  ],
  timeline: [
    {
      label: 'E6',
      at: new Date('2026-08-06T10:12:00.000Z'),
      kind: 'deployment',
      summary: 'Deployed payments-api v2.4.1 to production by ci-bot — succeeded',
      sourceUrl: 'https://github.com/acme/payments-api/deployments/4821',
    },
    {
      label: 'E1',
      at: new Date('2026-08-06T10:16:00.000Z'),
      kind: 'alert',
      summary: '[critical] Elevated 5xx rate on payments-api (via pagerduty)',
    },
  ],
  missingInformation: [],
  suggestedQuestions: ['Should REDIS_POOL_MAX be reverted to 50?'],
  model: 'gemini-2.5-flash',
  promptVersion: 'investigate/v1',
  generatedAt: new Date('2026-08-06T10:30:00.000Z'),
};

function blocksOf(type: Block['type'], blocks: readonly Block[]): Block[] {
  return blocks.filter((block) => block.type === type);
}

describe('rendering a report', () => {
  const reply = renderReport(report, 'INC-481');

  test('leads with what happened, so the first line is the answer', () => {
    expect(reply.text.split('\n')[0]).toContain('INC-481');
    expect(reply.text).toContain('A deploy [E6] preceded a 5xx spike [E1].');
  });

  test('states the leading hypothesis with its confidence', () => {
    expect(reply.text).toContain('95%');
    expect(reply.text).toContain('REDIS_POOL_MAX');
  });

  test('renders as blocks so every channel gets its native formatting', () => {
    expect(reply.blocks?.length).toBeGreaterThan(0);
  });

  test('deep-links buttons to the real evidence a human can go and check', () => {
    // "Here is the evidence" has to be a link someone can click, or the citation is just a claim.
    const [buttons] = blocksOf('buttons', reply.blocks ?? []);

    expect(buttons?.buttons?.some((b) => b.url?.includes('github.com/acme/payments-api'))).toBe(
      true,
    );
  });

  test('offers a callback button for the reasoning, handled by onInteraction', () => {
    const values = (reply.blocks ?? []).flatMap((b) => b.buttons ?? []).map((b) => b.value);

    expect(values).toContain('why');
  });

  test('stays legible with no blocks at all, for channels that strip them', () => {
    // X caps a post at 300 characters and renders no markdown; the text has to stand alone.
    expect(reply.text).not.toContain('*');
    expect(reply.text).not.toContain('#');
  });

  test('keeps the beginning and the end of a long timeline', () => {
    // Truncating a timeline from the end drops the climax: the deploy that caused it and the alert
    // that started the page both sort last, so a naive "first N" cut hides exactly what the
    // summary is talking about.
    const long = {
      ...report,
      timeline: Array.from({ length: 20 }, (_, i) => ({
        label: `E${i + 1}`,
        at: new Date(Date.UTC(2026, 7, 6, 10, i)),
        kind: i === 19 ? 'alert' : 'log_pattern',
        summary: i === 0 ? 'the first thing that happened' : `event ${i + 1}`,
      })),
    };

    const { text } = renderReport(long, 'INC-481');

    expect(text).toContain('the first thing that happened');
    expect(text).toContain('event 20');
  });

  test('does not abridge a timeline barely over the limit', () => {
    // Hiding one or two lines saves the reader nothing and can hide the change that caused the
    // incident — which is exactly what it did on the seeded incident, eliding REDIS_POOL_MAX.
    const slightlyLong = {
      ...report,
      timeline: Array.from({ length: 13 }, (_, i) => ({
        label: `E${i + 1}`,
        at: new Date(Date.UTC(2026, 7, 6, 10, i)),
        kind: 'log_pattern',
        summary: `event ${i + 1}`,
      })),
    };

    const { text } = renderReport(slightlyLong, 'INC-481');

    expect(text).not.toMatch(/further events/);
    for (let i = 1; i <= 13; i++) expect(text).toContain(`event ${i}`);
  });

  test('says how many timeline entries it left out, and where', () => {
    const long = {
      ...report,
      timeline: Array.from({ length: 20 }, (_, i) => ({
        label: `E${i + 1}`,
        at: new Date(Date.UTC(2026, 7, 6, 10, i)),
        kind: 'log_pattern',
        summary: `event ${i + 1}`,
      })),
    };

    expect(renderReport(long, 'INC-481').text).toMatch(/\d+ further events/i);
  });

  test('says plainly when nothing was missing', () => {
    expect(reply.text).toMatch(/every source reported/i);
  });

  test('names the blind spots when there were some', () => {
    const partial = renderReport(
      { ...report, missingInformation: ['datadog failed: 401 Unauthorized'] },
      'INC-481',
    );

    expect(partial.text).toContain('datadog failed: 401 Unauthorized');
  });

  test('is honest that the reasoning was replayed when it was', () => {
    const replayed = renderReport({ ...report, model: 'gemini-2.5-flash (replayed)' }, 'INC-481');

    expect(replayed.text).toMatch(/replayed/i);
  });
});

describe('rendering the reasoning behind a report', () => {
  test('gives each hypothesis with the evidence for and against it', () => {
    const reply = renderReasoning(report);

    expect(reply.text).toContain('REDIS_POOL_MAX');
    expect(reply.text).toContain('E4');
  });

  test('asks for an incident when there is nothing under discussion', () => {
    expect(renderReasoning(undefined).text).toMatch(/which incident/i);
  });
});

describe('rendering help', () => {
  test('shows what to type, not a wall of prose', () => {
    const reply = renderHelp();

    expect(reply.text).toContain('investigate');
    expect(reply.text).toContain('why');
  });
});
