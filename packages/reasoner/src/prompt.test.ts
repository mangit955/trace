import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  CollectorRunId,
  createEvidenceNode,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  type Investigation,
  newId,
  OrgId,
  registerCoreKinds,
  serializeForReasoning,
} from '@trace/domain';
import { buildPrompt, PROMPT_VERSION } from './prompt.ts';

const ALERT_AT = new Date('2026-08-06T10:16:00.000Z');

const registry = new EvidenceKindRegistry();
registerCoreKinds(registry);

function investigation(): Investigation {
  return createInvestigation({
    orgId: newId(OrgId),
    externalRef: { system: 'pagerduty', id: 'INC-481' },
    window: defaultWindowFor(ALERT_AT),
    now: ALERT_AT,
  });
}

function evidenceOf(target: Investigation) {
  const alert = createEvidenceNode({
    registry,
    orgId: target.orgId,
    investigationId: target.id,
    kind: 'alert',
    kindVersion: 1,
    payload: {
      source: 'pagerduty',
      externalId: 'INC-481',
      title: 'Elevated 5xx rate on payments-api',
      severity: 'critical',
      service: 'payments-api',
      firedAt: ALERT_AT.toISOString(),
    },
    connector: 'pagerduty',
    collectorRunId: newId(CollectorRunId),
    collectedAt: ALERT_AT,
  });

  const graph = buildEvidenceGraph({
    investigationId: target.id,
    nodes: [alert],
    edges: [],
  });

  return serializeForReasoning(graph, registry);
}

describe('buildPrompt', () => {
  const target = investigation();
  const evidence = evidenceOf(target);
  const gaps = ['datadog failed: request timed out'];

  test('is byte-identical for the same input', () => {
    // Same reason serialize.ts is deterministic: prompt caching, and "why did it say that?"
    // being answerable six months later.
    expect(buildPrompt({ investigation: target, evidence, gaps })).toBe(
      buildPrompt({ investigation: target, evidence, gaps }),
    );
  });

  test('includes the evidence with its citation labels', () => {
    const prompt = buildPrompt({ investigation: target, evidence, gaps });

    expect(prompt).toContain('[E1]');
    expect(prompt).toContain('Elevated 5xx rate on payments-api');
  });

  test('identifies the incident being investigated and the window searched', () => {
    const prompt = buildPrompt({ investigation: target, evidence, gaps });

    expect(prompt).toContain('pagerduty INC-481');
    expect(prompt).toContain(target.window.from.toISOString());
  });

  test('states the gaps, so the model does not reason as if evidence were complete', () => {
    const prompt = buildPrompt({ investigation: target, evidence, gaps });

    expect(prompt).toContain('datadog failed: request timed out');
  });

  test('tells the model gaps are not its to report', () => {
    // Missing information is computed from collector runs. Inviting the model to list gaps
    // produces a plausible, wrong list, since it cannot introspect what it was never shown.
    expect(buildPrompt({ investigation: target, evidence, gaps })).toMatch(
      /do not.*(gap|missing)/i,
    );
  });

  test('requires every claim to cite a label that was shown', () => {
    expect(buildPrompt({ investigation: target, evidence, gaps })).toMatch(/cite/i);
  });

  test('says plainly when nothing is missing, rather than omitting the section', () => {
    // An absent section reads as "unknown"; the model should know the evidence set is complete.
    const prompt = buildPrompt({ investigation: target, evidence, gaps: [] });

    expect(prompt).toMatch(/every configured source reported/i);
  });

  test('carries a version, so a stored hypothesis can be traced to the prompt that made it', () => {
    expect(PROMPT_VERSION).toMatch(/^investigate\/v\d+$/);
  });
});
