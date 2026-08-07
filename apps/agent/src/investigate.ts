import { collectEvidence } from '@trace/collectors';
import {
  buildEvidenceGraph,
  type CollectorRun,
  createInvestigation,
  defaultWindowFor,
  type EvidenceGraph,
  type ExternalRef,
  type Investigation,
  transition,
} from '@trace/domain';
import {
  type InvestigationReport,
  reasonAboutInvestigation,
  similaritySourceText,
  unreasonedReport,
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  return (await reportOrDegraded(deps, investigation)).report;
}

/** As `reportForInvestigation`, but says whether a model actually produced what it returns. */
async function reportOrDegraded(deps: AgentDeps, investigation: Investigation): Promise<Reasoned> {
  // A stored report is a reasoned one by construction — the degraded path never writes.
  const stored = await deps.store.reports.findFor(deps.tenant, investigation.id);
  if (stored) return { report: stored, reasoned: true };

  const outcome = await reasonOrDegrade(
    deps,
    investigation,
    await deps.store.evidence.loadGraph(deps.tenant, investigation.id),
    await deps.store.collectorRuns.listFor(deps.tenant, investigation.id),
  );

  // Only a real report is stored. See `runInvestigation` — persisting a degraded one makes a
  // transient outage permanent, because a stored report is never regenerated.
  if (outcome.reasoned) await deps.store.reports.save(deps.tenant, outcome.report);
  return outcome;
}

/**
 * Reasons about the evidence, or reports the reconstruction without an interpretation of it.
 *
 * The invariant is "a partial investigation is a success", and it turns out to apply one step later
 * than it was written for. The timeline and the blind spots are *computed* — projected off the
 * graph and off collector runs — so they are exactly as sound whether or not the model answered.
 * Letting a reasoner failure propagate discarded them and handed the user "Sorry, something went
 * wrong", which is the outcome that invariant exists to prevent.
 *
 * Hit for real, not imagined: with a broken `GITHUB_TOKEN` the live collector displaces its seeded
 * stand-in and then fails, the evidence set shrinks, and the recorded response cites a node that is
 * no longer in it. The citation gate rejects the whole response, correctly — the answer is not to
 * loosen the gate but to keep reporting the part the model never wrote.
 */
async function reasonOrDegrade(
  deps: AgentDeps,
  investigation: Investigation,
  graph: EvidenceGraph,
  runs: readonly CollectorRun[],
): Promise<Reasoned> {
  try {
    const report = await reasonAboutInvestigation({
      investigation,
      graph,
      registry: deps.registry,
      runs,
      reasoner: deps.reasoner,
      now: deps.clock.now(),
    });
    return { report, reasoned: true };
  } catch (error) {
    const reason = messageOf(error);
    console.error(`[trace] reasoning failed for ${investigation.externalRef.id}: ${reason}`);

    return {
      report: unreasonedReport({
        investigation,
        graph,
        registry: deps.registry,
        runs,
        reasonerModel: deps.reasoner.model,
        reason,
        now: deps.clock.now(),
      }),
      reasoned: false,
    };
  }
}

/**
 * A report, and whether a model actually produced it.
 *
 * Reported explicitly rather than inferred from `hypotheses.length === 0`. That inference happens
 * to hold today — `ReasonedOutput` requires at least one hypothesis — but it couples this file to a
 * `.min(1)` in a zod schema two packages away, and the consequence of the coupling silently
 * breaking is that a degraded report gets stored as final.
 */
interface Reasoned {
  report: InvestigationReport;
  reasoned: boolean;
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
    const { report, reasoned } = await reportOrDegraded(deps, existing);
    return {
      investigation: existing,
      report,
      // Same guard as below: a degraded summary is an error message, and embedding it would ask
      // "which past incident is most like this rate limit?" rather than like this outage.
      precedents: await findPrecedents(deps, existing, reasoned ? report : undefined),
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

  const graph = buildEvidenceGraph({
    investigationId: reasoning.id,
    nodes: collected.nodes,
    edges: collected.edges,
  });

  const { report, reasoned } = await reasonOrDegrade(deps, reasoning, graph, collected.runs);

  if (reasoned) {
    for (const hypothesis of report.hypotheses) {
      await deps.store.hypotheses.save(deps.tenant, hypothesis);
    }
    // Stored whole, so every follow-up in the thread explains this report rather than a new one.
    await deps.store.reports.save(deps.tenant, report);
  }
  // A degraded report is shown but never stored. A stored report is *never* regenerated, and
  // `ready` is terminal, so persisting one would turn a 429 — a normal Tuesday on a free tier —
  // into a permanent verdict: every later ask would replay the apology and the incident could
  // never be reasoned about again. Not storing it means the next ask reasons over the same
  // immutable evidence and succeeds the moment the quota comes back.

  const ready = transition(reasoning, 'ready', deps.clock.now());
  await deps.store.investigations.save(deps.tenant, ready);

  // Precedent is read *before* this investigation is indexed, so it cannot return itself as its own
  // nearest neighbour — `exclude` covers that too, but not indexing first means one fewer thing
  // depending on it.
  // The summary is folded into the embedding, so a degraded report would fingerprint this incident
  // by its own error message — making its nearest neighbour every *other* incident that hit a rate
  // limit. `SimilaritySourceInput.report` is optional for exactly this case: services and error
  // signatures come off the graph and still make a usable vector.
  const fingerprint = reasoned ? report : undefined;
  const precedents = await findPrecedents(deps, ready, fingerprint);
  await indexForSimilarity(deps, ready, fingerprint);

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
  report: InvestigationReport | undefined,
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
    // The message, not the object. This path is designed to fail quietly — a rate-limited embedder
    // is a normal Tuesday on a free tier — and dumping a stack trace through Bun's internals for a
    // convenience feature makes a working system look like it is crashing.
    console.error(`[trace] could not index for similarity: ${messageOf(error)}`);
  }
}

/** Prior investigations resembling this one. Also never fatal, for the same reason. */
async function findPrecedents(
  deps: AgentDeps,
  investigation: Investigation,
  report: InvestigationReport | undefined,
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
    console.error(`[trace] could not look up similar investigations: ${messageOf(error)}`);
    return [];
  }
}
