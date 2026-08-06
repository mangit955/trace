import { describe, expect, test } from 'bun:test';
import { collectEvidence } from '@trace/collectors';
import { fixtureCollectors, INC_481 } from '@trace/collectors/fixtures';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  newId,
  OrgId,
  registerCoreKinds,
  systemClock,
} from '@trace/domain';
import { PROMPT_VERSION } from './prompt.ts';
import { defaultRecordedReasoner, RECORDINGS } from './recordings.ts';
import { reasonAboutInvestigation } from './report.ts';

/**
 * Drift guards for the committed recordings.
 *
 * A recording is captured against one evidence graph and one prompt. Change the seeded incident or
 * the prompt and the capture silently stops describing what a reviewer would actually be shown —
 * the citations start pointing at different evidence, or at none. That failure is invisible to
 * every other test here, because they all supply their own recordings.
 *
 * This is the same class of bug that survived Phase 2's green suite: an artefact and the thing it
 * describes drifting apart, with a test asserting the stale version.
 */
describe('the committed recordings', () => {
  test('cover the seeded incident the credential-free demo investigates', () => {
    expect(RECORDINGS.map((recording) => recording.externalId)).toContain(INC_481.externalRef.id);
  });

  test('were captured against the prompt currently in force', () => {
    // If this fails, re-run `bun run capture:reasoning`. The stored reasoning was produced by a
    // prompt that no longer exists, so it no longer evidences anything about this build.
    for (const recording of RECORDINGS) {
      expect(recording.promptVersion).toBe(PROMPT_VERSION);
    }
  });

  test('cite only evidence the live seeded incident actually produces', async () => {
    const registry = new EvidenceKindRegistry();
    registerCoreKinds(registry);

    const investigation = createInvestigation({
      orgId: newId(OrgId),
      externalRef: INC_481.externalRef,
      window: defaultWindowFor(INC_481.alertAt),
      now: INC_481.alertAt,
    });

    const collected = await collectEvidence({
      collectors: fixtureCollectors(INC_481),
      investigation,
      registry,
      clock: systemClock,
    });

    // Runs the recording through the same citation gate live reasoning has to pass. A label that
    // no longer resolves throws HallucinatedCitationError here rather than in front of a reviewer.
    const report = await reasonAboutInvestigation({
      investigation,
      graph: buildEvidenceGraph({
        investigationId: investigation.id,
        nodes: collected.nodes,
        edges: collected.edges,
      }),
      registry,
      runs: collected.runs,
      reasoner: defaultRecordedReasoner(),
      now: new Date('2026-08-06T10:30:00.000Z'),
    });

    expect(report.hypotheses.length).toBeGreaterThan(0);
    for (const hypothesis of report.hypotheses) {
      expect(hypothesis.citations.length).toBeGreaterThan(0);
    }
  });

  test('are honest about being a replay rather than live reasoning', () => {
    expect(defaultRecordedReasoner().model).toContain('replayed');
  });
});
