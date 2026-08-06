import { githubCollectorFromEnv, selectCollectors } from '@trace/collectors';
import { fixtureCollectors, SEEDED_INCIDENTS } from '@trace/collectors/fixtures';
import { InMemoryStore } from '@trace/db';
import { EvidenceKindRegistry, newId, OrgId, registerCoreKinds, systemClock } from '@trace/domain';
import { defaultRecordedReasoner, selectReasoner } from '@trace/reasoner';
import type { AgentDeps } from './handler.ts';

/**
 * The composition root.
 *
 * Every "is this configured?" decision in Trace lives here and nowhere else, so the handler, the
 * collectors and the reasoner never ask what mode they are in. Adding a credential changes what
 * this function assembles; it changes no logic anywhere else.
 *
 * With nothing configured at all Trace is still a working agent: seeded incidents, seeded
 * collectors, and reasoning replayed from a genuine captured Gemini response.
 */
export function buildDeps(env: NodeJS.ProcessEnv = process.env): AgentDeps {
  const registry = new EvidenceKindRegistry();
  registerCoreKinds(registry);

  const seededIncidents = Object.values(SEEDED_INCIDENTS);
  const recorded = defaultRecordedReasoner();

  return {
    store: new InMemoryStore(),
    registry,
    // With a key, live Gemini with the recording behind it; without, the recording alone.
    reasoner: selectReasoner(
      {
        ...(env['GEMINI_API_KEY'] === undefined ? {} : { GEMINI_API_KEY: env['GEMINI_API_KEY'] }),
        ...(env['GEMINI_MODEL'] === undefined ? {} : { GEMINI_MODEL: env['GEMINI_MODEL'] }),
      },
      { recorded },
    ),
    collectorsFor: (ref) => {
      const seeded = seededIncidents.find((incident) => incident.externalRef.id === ref.id);
      return selectCollectors({
        seeded: seeded ? fixtureCollectors(seeded) : [],
        // The real GitHub collector takes over from its seeded stand-in the moment GITHUB_TOKEN
        // appears, and reports itself as a gap when it has no seed to fall back to.
        live: [
          githubCollectorFromEnv(env as { GITHUB_TOKEN?: string; TRACE_GITHUB_REPOS?: string }),
        ],
      });
    },
    seededIncidents,
    // Single-tenant deploy: one org, minted at startup. The tenant is still passed explicitly to
    // every repository call, so nothing has to change when a second one appears.
    tenant: { orgId: newId(OrgId) },
    clock: systemClock,
  };
}
