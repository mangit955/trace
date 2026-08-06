import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  missingInformationFrom,
  newId,
  OrgId,
  registerCoreKinds,
  systemClock,
} from '@trace/domain';
import { fixtureCollectors, INC_481 } from './fixtures/index.ts';
import { collectEvidence, githubCollectorFromEnv } from './index.ts';

/**
 * The demo path, driven through the public entry point only: seeded sources plus the real GitHub
 * collector with nothing configured. Every other test imports modules directly, so nothing else
 * would notice a barrel that forgot an export.
 */
describe('a credential-free collection through the public API', () => {
  async function run() {
    const registry = new EvidenceKindRegistry();
    registerCoreKinds(registry);

    const investigation = createInvestigation({
      orgId: newId(OrgId),
      externalRef: INC_481.externalRef,
      window: defaultWindowFor(INC_481.alertAt),
      now: INC_481.alertAt,
    });

    const result = await collectEvidence({
      collectors: [...fixtureCollectors(INC_481), githubCollectorFromEnv({})],
      investigation,
      registry,
      clock: systemClock,
    });

    return {
      ...result,
      graph: buildEvidenceGraph({
        investigationId: investigation.id,
        nodes: result.nodes,
        edges: result.edges,
      }),
    };
  }

  test('still produces a usable evidence graph', async () => {
    expect((await run()).graph.nodes.length).toBeGreaterThan(10);
  });

  test('reports the unconfigured connector as a known gap, in an operator-actionable form', async () => {
    expect(missingInformationFrom((await run()).runs)).toEqual([
      'github was not consulted: GITHUB_TOKEN is not set',
    ]);
  });
});
