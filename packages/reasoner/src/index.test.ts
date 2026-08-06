import { describe, expect, test } from 'bun:test';
import { collectEvidence, selectCollectors } from '@trace/collectors';
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
  transition,
} from '@trace/domain';
import { defaultRecordedReasoner, reasonAboutInvestigation, selectReasoner } from './index.ts';

/**
 * The whole pipeline, wired the way `apps/agent` will wire it in Phase 4, driven through the public
 * entry point only.
 *
 * Composing the pieces the way the *next* caller will is what caught a collector name collision in
 * Phase 2 that every unit test had missed.
 */
describe('an end-to-end investigation with no credentials', () => {
  async function investigate() {
    const registry = new EvidenceKindRegistry();
    registerCoreKinds(registry);

    const investigation = createInvestigation({
      orgId: newId(OrgId),
      externalRef: INC_481.externalRef,
      window: defaultWindowFor(INC_481.alertAt),
      now: INC_481.alertAt,
    });

    const collecting = transition(investigation, 'collecting', INC_481.alertAt);
    const collected = await collectEvidence({
      collectors: selectCollectors({ seeded: fixtureCollectors(INC_481), live: [] }),
      investigation: collecting,
      registry,
      clock: systemClock,
    });

    const report = await reasonAboutInvestigation({
      investigation: collecting,
      graph: buildEvidenceGraph({
        investigationId: collecting.id,
        nodes: collected.nodes,
        edges: collected.edges,
      }),
      registry,
      runs: collected.runs,
      reasoner: selectReasoner({}, { recorded: defaultRecordedReasoner() }),
      now: INC_481.alertAt,
    });

    const ready = transition(
      transition(collecting, 'reasoning', INC_481.alertAt),
      'ready',
      INC_481.alertAt,
    );

    return { report, ready };
  }

  test('reaches a ready investigation carrying a cited report', async () => {
    const { report, ready } = await investigate();

    expect(ready.status).toBe('ready');
    expect(report.summary.length).toBeGreaterThan(0);
    expect(report.hypotheses.length).toBeGreaterThan(0);
  });

  test('reconstructs the cause, and ranks the decoy change below it', async () => {
    // The seeded incident deliberately contains an unrelated feature flag change. A reasoner that
    // cannot tell it apart from the real cause is not doing the job the product claims.
    const { report } = await investigate();
    const [leading] = report.hypotheses;

    expect(leading?.statement).toContain('REDIS_POOL_MAX');
    for (const hypothesis of report.hypotheses.slice(1)) {
      expect(hypothesis.confidence).toBeLessThan(leading?.confidence ?? 0);
    }
  });

  test('every citation resolves to evidence in the graph it was shown', async () => {
    const { report } = await investigate();

    for (const hypothesis of report.hypotheses) {
      for (const citation of hypothesis.citations) {
        expect(hypothesis.evidenceSeen).toContain(citation.nodeId);
      }
    }
  });

  test('reports no blind spots, because every seeded source answered', async () => {
    expect((await investigate()).report.missingInformation).toEqual([]);
  });

  test('orders the timeline by when things happened, not by citation label', async () => {
    const { timeline } = (await investigate()).report;
    const times = timeline.map((entry) => entry.at.getTime());

    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
