import { collectEvidence } from '@trace/collectors';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  type ExternalRef,
  type Investigation,
  transition,
} from '@trace/domain';
import { type InvestigationReport, reasonAboutInvestigation } from '@trace/reasoner';
import type { AgentDeps } from './handler.ts';

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
    return { investigation: existing, report: await reportForInvestigation(deps, existing) };
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

  return { investigation: ready, report };
}
