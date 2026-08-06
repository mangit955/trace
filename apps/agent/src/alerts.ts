import type { ExternalRef } from '@trace/domain';

/**
 * Proactive outreach, and the rules that keep it from becoming spam.
 *
 * An agent that can start conversations is an agent that can wake people up at 3am, so this is the
 * most constrained code in the project:
 *
 *  - **only to an operator-configured allowlist** — an unset `TRACE_ONCALL_RECIPIENTS` means Trace
 *    contacts nobody, ever, rather than falling back to some default;
 *  - **only in response to a real alert**, never on a timer or a hunch;
 *  - **once per incident**, because PagerDuty retries webhook deliveries and three identical pages
 *    are worse than none.
 *
 * Everything after the first message happens in the thread the reply creates, so the conversation
 * stays where the engineer answered it.
 */

/** The narrow slice of `CommClient` this needs — `initiate(connectionId, recipient, text)`. */
export interface Initiator {
  initiate(connectionId: string, recipient: string, text: string): Promise<unknown>;
}

export interface OutboundAttempt {
  connectionId: string;
  recipient: string;
  text: string;
}

export interface IncidentAlert {
  externalRef: ExternalRef;
  summary: string;
}

export interface NotifyOnCallInput {
  client: Initiator;
  /** From `connectTelegram`/`installSlack`; outbound needs the connection to send on. */
  connectionId: string;
  recipients: readonly string[];
  alert: IncidentAlert;
  /** Incidents already announced. Held by the caller so it survives across webhook deliveries. */
  alreadyNotified: Set<string>;
}

/**
 * Parses the operator's allowlist.
 *
 * Absent, empty or whitespace all mean the same thing: nobody. The default has to be silence,
 * because an agent that messages strangers whenever a variable is forgotten is its own incident.
 */
export function recipientsFrom(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((recipient) => recipient.trim())
    .filter((recipient) => recipient.length > 0);
}

export async function notifyOnCall(input: NotifyOnCallInput): Promise<void> {
  const key = `${input.alert.externalRef.system}:${input.alert.externalRef.id}`;
  if (input.alreadyNotified.has(key)) return;
  if (input.recipients.length === 0) return;

  // Marked before sending, not after: a partial failure mid-rotation must not cause a second full
  // round of pages when the webhook is redelivered.
  input.alreadyNotified.add(key);

  const text =
    `${input.alert.externalRef.id}: ${input.alert.summary}\n\n` +
    'I am reconstructing what happened. Reply "why" for my reasoning, or ask me anything about it.';

  for (const recipient of input.recipients) {
    try {
      await input.client.initiate(input.connectionId, recipient, text);
    } catch (error) {
      // One unreachable address must not silence the rest of the rotation.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[trace] could not reach ${recipient}: ${detail}`);
    }
  }
}
