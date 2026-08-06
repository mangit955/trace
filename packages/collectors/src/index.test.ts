import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  type Investigation,
  missingInformationFrom,
  newId,
  OrgId,
  registerCoreKinds,
  systemClock,
} from '@trace/domain';
import { fixtureCollectors, INC_481 } from './fixtures/index.ts';
import {
  type Collector,
  collectEvidence,
  githubCollector,
  githubCollectorFromEnv,
  selectCollectors,
} from './index.ts';

/**
 * The two modes Trace ships in, driven through the public entry point only.
 *
 * Every other test imports modules directly, so nothing else would notice a barrel that forgot an
 * export — and nothing else exercises the seeded/live switch a reviewer's first run depends on.
 */
describe('composing an investigation', () => {
  function investigation(): Investigation {
    return createInvestigation({
      orgId: newId(OrgId),
      externalRef: INC_481.externalRef,
      window: defaultWindowFor(INC_481.alertAt),
      now: INC_481.alertAt,
    });
  }

  async function run(collectors: readonly Collector[]) {
    const registry = new EvidenceKindRegistry();
    registerCoreKinds(registry);
    const target = investigation();

    const result = await collectEvidence({
      collectors,
      investigation: target,
      registry,
      clock: systemClock,
    });

    return {
      ...result,
      graph: buildEvidenceGraph({
        investigationId: target.id,
        nodes: result.nodes,
        edges: result.edges,
      }),
    };
  }

  const seeded = () => fixtureCollectors(INC_481);

  describe('with no credentials, as a reviewer first runs it', () => {
    const collectors = () =>
      selectCollectors({ seeded: seeded(), live: [githubCollectorFromEnv({})] });

    test('produces a usable evidence graph', async () => {
      expect((await run(collectors())).graph.nodes.length).toBeGreaterThan(10);
    });

    test('reports no gaps, because the seeded source covers the unconfigured connector', async () => {
      // Reporting "github was not consulted" beside the GitHub evidence the seed provided would
      // make the gap list wrong, and the gap list is the part of a report meant to be trusted
      // unconditionally.
      expect(missingInformationFrom((await run(collectors())).runs)).toEqual([]);
    });
  });

  describe('with a GitHub token configured', () => {
    const live = () =>
      githubCollector({
        token: 'ghp_test',
        repos: ['acme/payments-api'],
        fetch: (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch,
      });

    test('the live collector replaces the seeded source of the same name', async () => {
      const { runs, nodes } = await run(selectCollectors({ seeded: seeded(), live: [live()] }));

      expect(runs.filter((entry) => entry.collector === 'github')).toHaveLength(1);
      expect(nodes.some((node) => node.connector === 'github')).toBe(false);
    });

    test('an empty repository is reported as a gap rather than passed off as no change', async () => {
      const gaps = missingInformationFrom(
        (await run(selectCollectors({ seeded: seeded(), live: [live()] }))).runs,
      );

      expect(gaps).toEqual(['github returned no evidence for this window']);
    });
  });
});
