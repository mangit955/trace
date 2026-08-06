import { z } from 'zod';
import { InvestigationId, newId, OrgId } from '../ids.ts';

/**
 * The Investigation aggregate.
 *
 * Trace does not own incident lifecycle — PagerDuty, Datadog and friends already do, and competing
 * with them would mean asking a team to change how they run on-call before Trace does anything
 * useful. An Investigation therefore *mirrors* an external incident via `externalRef` and owns only
 * the part nobody else does: the reconstruction.
 *
 * `ready` and `failed` are terminal. Re-investigating creates a new Investigation rather than
 * reopening this one, because evidence is immutable and citations made against it must keep
 * resolving to the same nodes forever.
 */

/** How far back to look for the change that caused an alert. */
export const DEFAULT_LOOKBACK_MINUTES = 60;
/** How far past the alert to look, to capture blast radius and knock-on failures. */
export const DEFAULT_FORWARD_MINUTES = 15;

export const InvestigationStatus = z.enum([
  'pending',
  'collecting',
  'reasoning',
  'ready',
  'failed',
]);
export type InvestigationStatus = z.infer<typeof InvestigationStatus>;

export const ExternalRef = z.object({
  /** The system of record: "pagerduty", "datadog", … */
  system: z.string().min(1).max(100),
  id: z.string().min(1).max(200),
});
export type ExternalRef = z.infer<typeof ExternalRef>;

export const TimeWindow = z.object({ from: z.date(), to: z.date() });
export type TimeWindow = z.infer<typeof TimeWindow>;

export const Investigation = z.object({
  id: InvestigationId,
  orgId: OrgId,
  externalRef: ExternalRef,
  status: InvestigationStatus,
  /** The slice of time evidence is collected across. */
  window: TimeWindow,
  failureReason: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Investigation = z.infer<typeof Investigation>;

/**
 * Legal state transitions.
 *
 * Encoded as data rather than a switch so the machine is inspectable — a diagram can be generated
 * from it, and adding a state forces you to state its edges explicitly.
 */
const TRANSITIONS: Record<InvestigationStatus, readonly InvestigationStatus[]> = {
  pending: ['collecting', 'failed'],
  collecting: ['reasoning', 'failed'],
  reasoning: ['ready', 'failed'],
  ready: [],
  failed: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: InvestigationStatus,
    readonly to: InvestigationStatus,
  ) {
    const allowed = TRANSITIONS[from];
    const options = allowed.length > 0 ? allowed.join(', ') : 'none (terminal state)';
    super(
      `Cannot move investigation from "${from}" to "${to}". Allowed from "${from}": ${options}.`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export function isTerminal(status: InvestigationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export interface CreateInvestigationInput {
  orgId: OrgId;
  externalRef: ExternalRef;
  window: TimeWindow;
  /** Injected rather than read from the system clock, so time is testable and replayable. */
  now: Date;
}

export function createInvestigation(input: CreateInvestigationInput): Investigation {
  if (input.window.to.getTime() <= input.window.from.getTime()) {
    throw new Error(
      `Invalid investigation window: "to" (${input.window.to.toISOString()}) must be after ` +
        `"from" (${input.window.from.toISOString()}).`,
    );
  }

  return {
    id: newId(InvestigationId),
    orgId: input.orgId,
    externalRef: input.externalRef,
    status: 'pending',
    window: input.window,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** Advances the state machine, returning a new Investigation. Throws on an illegal transition. */
export function transition(
  investigation: Investigation,
  to: InvestigationStatus,
  now: Date,
): Investigation {
  if (!TRANSITIONS[investigation.status].includes(to)) {
    throw new IllegalTransitionError(investigation.status, to);
  }
  return { ...investigation, status: to, updatedAt: now };
}

/**
 * Moves an investigation to `failed` with a reason.
 *
 * Separate from {@link transition} because a failure without an explanation is not actionable —
 * whoever reads this later needs to know whether to retry or fix something.
 */
export function fail(investigation: Investigation, reason: string, now: Date): Investigation {
  if (reason.trim().length === 0) {
    throw new Error('A failure reason is required; an unexplained failure is not actionable.');
  }
  return { ...transition(investigation, 'failed', now), failureReason: reason };
}

/**
 * The default slice of time to investigate around an alert.
 *
 * Asymmetric on purpose: the cause almost always precedes the alert (a deploy, a config change),
 * while the window after it mostly shows blast radius.
 */
export function defaultWindowFor(anchor: Date): TimeWindow {
  return {
    from: new Date(anchor.getTime() - DEFAULT_LOOKBACK_MINUTES * 60_000),
    to: new Date(anchor.getTime() + DEFAULT_FORWARD_MINUTES * 60_000),
  };
}
