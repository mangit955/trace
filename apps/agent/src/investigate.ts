import { collectEvidence } from '@trace/collectors';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  type ExternalRef,
  type Investigation,
  transition,
} from '@trace/domain';
import {
  type InvestigationReport,
  reasonAboutInvestigation,
  similaritySourceText,
} from '@trace/reasoner';
import type { AgentDeps } from './handler.ts';
import type { Precedent } from './render.ts';

/**
 * Running an investigation end to end.
 *
 * Pure orchestration: collect, build the graph, reason, persist. Every step already exists and is
 * already tested — this file adds no logic of its own, which is the point. If it grew a rule about
 * evidence or causation, that rule would be invisible to the domain's tests.
 *
 * Failure handling lives one level up, in the handler, so a collector outage produces a partial
 * report here rather than an exception.
 */

export interface InvestigationOutcome {
  investigation: Investigation;
  report: InvestigationReport;
  /** Prior investigations this one resembles. Empty when there is no history to resemble. */
  precedents: readonly Precedent[];
}

/** How many prior incidents to show. Three is a hint; ten is a second report to read. */
const MAX_PRECEDENTS = 3;

/**
 * The report for an investigation — the one the engineer was actually shown.
 *
 * Read back rather than regenerated. Reasoning is neither free nor deterministic: re-running it to
 * answer "why?" took 40 seconds on a real Telegram thread and could return different hypotheses,
 * which would mean explaining a conclusion nobody was ever shown.
 *
 * Re-reasoning only happens when there is no stored report, which means an investigation that
 * predates the store or one whose reasoning failed the first time.
 */
export async function reportForInvestigation(
  deps: AgentDeps,
  investigation: Investigation,
): Promise<InvestigationReport> {
  const stored = await deps.store.reports.findFor(deps.tenant, investigation.id);
  if (stored) return stored;

  const report = await reasonAboutInvestigation({
    investigation,
    graph: await deps.store.evidence.loadGraph(deps.tenant, investigation.id),
    registry: deps.registry,
    runs: await deps.store.collectorRuns.listFor(deps.tenant, investigation.id),
    reasoner: deps.reasoner,
    now: deps.clock.now(),
  });

  await deps.store.reports.save(deps.tenant, report);
  return report;
}

export async function runInvestigation(
  deps: AgentDeps,
  externalRef: ExternalRef,
  alertAt: Date,
): Promise<InvestigationOutcome> {
  const now = deps.clock.now();

  // Trace mirrors incidents, it does not own them, so an incident already reconstructed is shown
  // again rather than reconstructed twice — and `ready` is a *terminal* state, so re-running one
  // would mean creating a whole new Investigation. Handled here rather than at each call site,
  // because both the chat handler and the alert webhook can arrive at an incident already done.
  const existing = await deps.store.investigations.findByExternalRef(deps.tenant, externalRef);
  if (existing?.status === 'ready') {
    const report = await reportForInvestigation(deps, existing);
    return {
      investigation: existing,
      report,
      precedents: await findPrecedents(deps, existing, report),
    };
  }

  const investigation =
    existing ??
    createInvestigation({
      orgId: deps.tenant.orgId,
      externalRef,
      window: defaultWindowFor(alertAt),
      now,
    });

  if (!existing) await deps.store.investigations.save(deps.tenant, investigation);

  const collecting = transition(investigation, 'collecting', now);
  await deps.store.investigations.save(deps.tenant, collecting);

  const collected = await (deps.collect ?? collectEvidence)({
    collectors: deps.collectorsFor(externalRef),
    investigation: collecting,
    registry: deps.registry,
    clock: deps.clock,
  });

  await deps.store.evidence.append(deps.tenant, collecting.id, collected.nodes, collected.edges);
  for (const run of collected.runs) await deps.store.collectorRuns.save(deps.tenant, run);

  const reasoning = transition(collecting, 'reasoning', deps.clock.now());
  await deps.store.investigations.save(deps.tenant, reasoning);

  const report = await reasonAboutInvestigation({
    investigation: reasoning,
    graph: buildEvidenceGraph({
      investigationId: reasoning.id,
      nodes: collected.nodes,
      edges: collected.edges,
    }),
    registry: deps.registry,
    runs: collected.runs,
    reasoner: deps.reasoner,
    now: deps.clock.now(),
  });

  for (const hypothesis of report.hypotheses) {
    await deps.store.hypotheses.save(deps.tenant, hypothesis);
  }
  // Stored whole, so every follow-up in the thread explains this report rather than a new one.
  await deps.store.reports.save(deps.tenant, report);

  const ready = transition(reasoning, 'ready', deps.clock.now());
  await deps.store.investigations.save(deps.tenant, ready);

  // Precedent is read *before* this investigation is indexed, so it cannot return itself as its own
  // nearest neighbour — `exclude` covers that too, but not indexing first means one fewer thing
  // depending on it.
  const precedents = await findPrecedents(deps, ready, report);
  await indexForSimilarity(deps, ready, report);

  return { investigation: ready, report, precedents };
}

/**
 * Records this investigation's embedding, so the *next* one can find it.
 *
 * Never fatal. An embedding provider that is down or rate-limited must not fail an investigation
 * that has already been reconstructed and shown — "has this happened before" is a convenience, and
 * the reconstruction is the product.
 */
async function indexForSimilarity(
  deps: AgentDeps,
  investigation: Investigation,
  report: InvestigationReport,
): Promise<void> {
  if (!deps.embedder) return;

  try {
    const graph = await deps.store.evidence.loadGraph(deps.tenant, investigation.id);
    const sourceText = similaritySourceText({ graph, registry: deps.registry, report });

    await deps.store.similarity.index(deps.tenant, {
      investigationId: investigation.id,
      embedding: await deps.embedder.embed(sourceText),
      sourceText,
      model: deps.embedder.model,
    });
  } catch (error) {
    console.error('[trace] could not index for similarity:', error);
  }
}

/** Prior investigations resembling this one. Also never fatal, for the same reason. */
async function findPrecedents(
  deps: AgentDeps,
  investigation: Investigation,
  report: InvestigationReport,
): Promise<readonly Precedent[]> {
  if (!deps.embedder) return [];

  try {
    const graph = await deps.store.evidence.loadGraph(deps.tenant, investigation.id);
    const embedding = await deps.embedder.embed(
      similaritySourceText({ graph, registry: deps.registry, report }),
    );

    const found = await deps.store.similarity.findSimilar(deps.tenant, {
      embedding,
      // Only incidents indexed by *this* model are comparable. After a model change precedent goes
      // quiet until they are re-indexed, which is the right failure: a wrong "we have seen this
      // before" sends an on-call engineer down a path unrelated to the incident in front of them.
      model: deps.embedder.model,
      limit: MAX_PRECEDENTS,
      exclude: investigation.id,
    });

    // The floor comes from the embedder, because the two backends score on different scales —
    // Gemini rates *unrelated* incident text above 0.86, where the lexical embedder rates a genuine
    // match at 0.94. A constant here showed a CMS image-link bug as "87% similar" to a Redis
    // outage.
    return found
      .filter((match) => match.score >= (deps.embedder?.minSimilarity ?? 1))
      .map((match) => ({ incidentId: match.externalRef.id, score: match.score }));
  } catch (error) {
    console.error('[trace] could not look up similar investigations:', error);
    return [];
  }
}
