import { githubCollectorFromEnv, selectCollectors } from '@trace/collectors';
import { fixtureCollectors, SEEDED_INCIDENTS } from '@trace/collectors/fixtures';
import { InMemoryStore, PostgresStore, type TraceStore } from '@trace/db';
import { EvidenceKindRegistry, OrgId, registerCoreKinds, systemClock } from '@trace/domain';
import { defaultRecordedReasoner, selectEmbedder, selectReasoner } from '@trace/reasoner';
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
/**
 * The tenant a single-tenant deploy runs as.
 *
 * A constant, not `newId(OrgId)` per start. Every row Trace writes is scoped by this value, so a
 * freshly minted one on each boot would file an investigation under an org nobody ever queries
 * again — against Postgres the data survives the restart and every read filters it out, which
 * presents as "persistence does not work" with a green suite. Harmless in memory, which is exactly
 * why it lasted until there was a database.
 */
const DEFAULT_ORG_ID = '019949d4-0000-7000-8000-000000000001';

function tenantFrom(env: NodeJS.ProcessEnv): { orgId: OrgId } {
  const configured = env['TRACE_ORG_ID'] ?? DEFAULT_ORG_ID;
  const parsed = OrgId.safeParse(configured);

  if (!parsed.success) {
    // Refused at startup rather than at the first query. A typo here does not error, it silently
    // becomes a different tenant, and the operator sees every investigation they had disappear.
    throw new Error(`TRACE_ORG_ID must be a UUID; got "${configured}".`);
  }

  return { orgId: parsed.data };
}

/**
 * Opens whichever store is configured.
 *
 * Separate from `buildDeps` and asynchronous, because connecting is I/O and building dependencies
 * is not. Keeping `buildDeps` synchronous means every existing caller — including the tests — is
 * untouched by the arrival of a database.
 *
 * With no `DATABASE_URL` this returns the in-memory store, which is a real implementation held to
 * the same contract suite, not a stand-in: `bun run dev` is a working agent with nothing installed.
 */
export async function openStore(env: NodeJS.ProcessEnv = process.env): Promise<TraceStore> {
  const url = env['DATABASE_URL'];
  if (!url) return new InMemoryStore();

  // Migrations run inside `connect`, and the tenant row is created before anything references it,
  // so `docker compose up` followed by `bun start` is the entire setup.
  try {
    return await PostgresStore.connect(url, [tenantFrom(env).orgId]);
  } catch (error) {
    // Unwrapped, an unreachable database prints `PostgresError: Connection closed` over a stack
    // trace through Bun's internals — true, and useless to whoever has to fix it. Deliberately not
    // a silent fall back to the in-memory store: someone who set DATABASE_URL wants persistence,
    // and quietly running without it is how an incident history goes missing unnoticed.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not open the database at ${redactUrl(url)}: ${detail}\n` +
        'Is it running? `docker compose up -d` starts one on port 5433.\n' +
        'To run with no database at all, unset DATABASE_URL and use `bun run dev`.',
    );
  }
}

/** Keeps the password out of logs and error reports; a DSN routinely carries one. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

export function buildDeps(env: NodeJS.ProcessEnv = process.env, store?: TraceStore): AgentDeps {
  const registry = new EvidenceKindRegistry();
  registerCoreKinds(registry);

  const seededIncidents = Object.values(SEEDED_INCIDENTS);
  const recorded = defaultRecordedReasoner();

  return {
    store: store ?? new InMemoryStore(),
    registry,
    // With a key, real Gemini embeddings; without, deterministic lexical overlap. Either way
    // "has this happened before?" answers — a feature that vanished without a credential is a
    // feature a reviewer never sees.
    embedder: selectEmbedder(
      env['GEMINI_API_KEY'] === undefined ? {} : { GEMINI_API_KEY: env['GEMINI_API_KEY'] },
    ),
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
    // Single-tenant deploy: one org, stable across restarts. The tenant is still passed explicitly
    // to every repository call, so nothing has to change when a second one appears.
    tenant: tenantFrom(env),
    clock: systemClock,
  };
}
