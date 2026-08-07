import { z } from 'zod';
import { type IncidentAlert, type Initiator, notifyOnCall } from './alerts.ts';
import type { AgentDeps } from './handler.ts';
import { runInvestigation } from './investigate.ts';

/**
 * The one place Trace speaks first.
 *
 * An alerting system posts here when an incident opens; Trace reconstructs it and pages the
 * on-call rotation with the answer already in hand, rather than waiting to be asked. That is the
 * whole value of proactive outreach — arriving with the reconstruction, not with a notification.
 *
 * It is also the only path in the system that can start a conversation with a human, so it carries
 * the constraints from `alerts.ts`: an operator-configured allowlist, once per incident, and
 * silence by default. The investigation happens either way — it is worth having the moment anyone
 * asks, whether or not Trace was allowed to speak first.
 */

/**
 * What an alert webhook must send.
 *
 * Parsed rather than trusted: this is an unauthenticated-ish edge taking JSON from a third party,
 * and a malformed payload should be a clean rejection rather than a half-finished investigation.
 */
export const AlertPayload = z.object({
  /** The system of record: `pagerduty`, `datadog`, … */
  system: z.string().min(1).max(100),
  id: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  /** When the alert fired. The investigation window is anchored here; defaults to now. */
  firedAt: z.iso.datetime().optional(),
});
export type AlertPayload = z.infer<typeof AlertPayload>;

export interface AlertIngress {
  agent: AgentDeps;
  /** From `TRACE_ONCALL_RECIPIENTS`. Empty means Trace never speaks first. */
  recipients: readonly string[];
  /** Incidents already announced, held across webhook deliveries. */
  alreadyNotified: Set<string>;
  /** Absent when no channel is connected — then there is simply nothing to send on. */
  outbound?: {
    client: Initiator;
    connectionId: string;
  };
}

export interface AlertOutcome {
  investigated: boolean;
  notified: number;
}

export async function receiveAlert(
  ingress: AlertIngress,
  rawPayload: unknown,
): Promise<AlertOutcome> {
  const parsed = AlertPayload.safeParse(rawPayload);
  if (!parsed.success) {
    throw new Error(
      `Not a usable alert: ${parsed.error.issues[0]?.message ?? 'unrecognised payload'}. ` +
        'Expected { system, id, summary, firedAt? }.',
    );
  }

  const alert = parsed.data;
  const externalRef = { system: alert.system, id: alert.id };
  const firedAt = alert.firedAt ? new Date(alert.firedAt) : ingress.agent.clock.now();

  // Idempotent by construction: `runInvestigation` looks up by external ref first, so a redelivered
  // webhook reuses the investigation rather than forking the evidence.
  const { report } = await runInvestigation(ingress.agent, externalRef, firedAt);

  if (!ingress.outbound) return { investigated: true, notified: 0 };

  const before = ingress.alreadyNotified.size;
  // The reconstruction is finished by the time anyone is paged, so the page carries the finding
  // rather than a promise to look into it.
  const leading = report.hypotheses[0];
  const incident: IncidentAlert = {
    externalRef,
    summary: alert.summary,
    ...(leading
      ? { finding: `Most likely (${Math.round(leading.confidence * 100)}%): ${leading.statement}` }
      : {
          // No hypothesis means reasoning failed, *not* that it is still running. The default
          // "I am reconstructing what happened now" would page someone to wait for a follow-up
          // that is never coming — and the reconstruction they could actually use is already
          // sitting there, one "why" away.
          finding: `I reconstructed ${report.timeline.length} events but could not reach a conclusion. Ask me for the timeline.`,
        }),
  };

  await notifyOnCall({
    client: ingress.outbound.client,
    connectionId: ingress.outbound.connectionId,
    recipients: ingress.recipients,
    alert: incident,
    alreadyNotified: ingress.alreadyNotified,
  });

  // `notifyOnCall` records the incident only when it actually pages, so this reports what happened
  // rather than what was attempted.
  const paged = ingress.alreadyNotified.size > before ? ingress.recipients.length : 0;
  return { investigated: true, notified: paged };
}
