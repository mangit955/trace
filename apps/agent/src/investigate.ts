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

export async function runInvestigation(
  deps: AgentDeps,
  externalRef: ExternalRef,
  alertAt: Date,
): Promise<InvestigationOutcome> {
  const now = deps.clock.now();

  // Trace mirrors incidents, it does not own them, so an incident already investigated is looked
  // up rather than duplicated. Re-asking about INC-481 must not fork the evidence.
  const existing = await deps.store.investigations.findByExternalRef(deps.tenant, externalRef);
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

  const ready = transition(reasoning, 'ready', deps.clock.now());
  await deps.store.investigations.save(deps.tenant, ready);

  return { investigation: ready, report };
}
