import { z } from 'zod';
import { CollectorRunId, InvestigationId, newId, OrgId } from '../ids.ts';

/**
 * A single collector's attempt to gather evidence.
 *
 * This type exists so that **"what we don't know" is computed, not generated**. Asking a language
 * model to describe the gaps in its own evidence does not work — it cannot introspect what it was
 * never shown, and will confidently produce a plausible-sounding list. The collector runs table
 * knows exactly which sources failed, which were never configured, and which came back empty.
 *
 * One failing collector must never fail an investigation. A partial reconstruction with an honest
 * list of blind spots is far more useful at 3am than an error.
 */

export const CollectorRunStatus = z.enum(['running', 'succeeded', 'failed', 'skipped']);
export type CollectorRunStatus = z.infer<typeof CollectorRunStatus>;

export const CollectorRun = z.object({
  id: CollectorRunId,
  orgId: OrgId,
  investigationId: InvestigationId,
  /** Which collector: "github", "datadog", … */
  collector: z.string().min(1),
  status: CollectorRunStatus,
  /** How many evidence nodes it contributed. Zero from a success is itself a finding. */
  nodeCount: z.number().int().nonnegative(),
  error: z.string().optional(),
  skippedReason: z.string().optional(),
  startedAt: z.date(),
  finishedAt: z.date().optional(),
});
export type CollectorRun = z.infer<typeof CollectorRun>;

export interface StartCollectorRunInput {
  orgId: OrgId;
  investigationId: InvestigationId;
  collector: string;
  now: Date;
}

export function startCollectorRun(input: StartCollectorRunInput): CollectorRun {
  return {
    id: newId(CollectorRunId),
    orgId: input.orgId,
    investigationId: input.investigationId,
    collector: input.collector,
    status: 'running',
    nodeCount: 0,
    startedAt: input.now,
  };
}

export function completeCollectorRun(
  run: CollectorRun,
  nodeCount: number,
  now: Date,
): CollectorRun {
  return { ...run, status: 'succeeded', nodeCount, finishedAt: now };
}

export function failCollectorRun(run: CollectorRun, error: string, now: Date): CollectorRun {
  if (error.trim().length === 0) {
    throw new Error(
      `Collector "${run.collector}" failed without a reason; an unexplained gap is not actionable.`,
    );
  }
  return { ...run, status: 'failed', error: error.trim(), finishedAt: now };
}

/**
 * Marks a collector as deliberately not run — usually because it is not configured.
 *
 * Distinct from failure on purpose. "GITHUB_TOKEN is not set" tells an operator to add a token;
 * "HTTP 500 from GitHub" tells them to wait. Conflating the two sends people to debug a collector
 * that was never meant to run.
 */
export function skipCollectorRun(run: CollectorRun, reason: string, now: Date): CollectorRun {
  if (reason.trim().length === 0) {
    throw new Error(`Collector "${run.collector}" was skipped without a reason.`);
  }
  return { ...run, status: 'skipped', skippedReason: reason.trim(), finishedAt: now };
}

/**
 * Describes the blind spots in an investigation, in stable order.
 *
 * Collectors finish in nondeterministic order; the resulting report must not, or the same evidence
 * would produce a differently-worded investigation on every run.
 */
export function missingInformationFrom(runs: readonly CollectorRun[]): readonly string[] {
  const gaps: string[] = [];

  for (const run of [...runs].sort((a, b) => a.collector.localeCompare(b.collector))) {
    switch (run.status) {
      case 'failed':
        gaps.push(`${run.collector} failed: ${run.error ?? 'unknown error'}`);
        break;
      case 'skipped':
        gaps.push(`${run.collector} was not consulted: ${run.skippedReason ?? 'not configured'}`);
        break;
      case 'running':
        gaps.push(`${run.collector} did not finish in time`);
        break;
      case 'succeeded':
        // A clean run that found nothing is a real finding, but it is still an absence the
        // reasoner should weigh — "no deploys in the window" is different from "deploys unknown".
        if (run.nodeCount === 0) {
          gaps.push(`${run.collector} returned no evidence for this window`);
        }
        break;
    }
  }

  return gaps;
}
