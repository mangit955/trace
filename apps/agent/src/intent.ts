/**
 * What the user is asking for.
 *
 * Pure text in, a tagged union out — no I/O, no channel awareness, no model call. Intent parsing is
 * the one place where being deterministic and dull is a feature: an on-call engineer typing on a
 * phone at 3am should not discover that their message was routed by an LLM's mood.
 *
 * Anything unrecognised becomes a `question`, which the handler answers from the stored report
 * rather than rejecting. "I didn't understand that" is the least useful thing an incident agent can
 * say to someone who is already having a bad night.
 */

export type Intent =
  | { kind: 'investigate'; incidentId: string }
  | { kind: 'why' }
  | { kind: 'show'; subject: string }
  | { kind: 'help' }
  | { kind: 'question'; text: string };

/**
 * Incident identifiers as the alerting tools of the world write them: `INC-481`, `PD-12`, `1234`.
 *
 * Deliberately narrow. A looser pattern would swallow ordinary words and start investigations
 * nobody asked for.
 */
const INCIDENT_ID = /\b([a-z]{2,10}-\d{1,8})\b/i;

const WHY = /\b(why|how come|what caused|root cause)\b/i;
const HELP = /^\/?(help|\?|what can you do)\b/i;
const SHOW = /\b(?:show|display|give me)\b\s+(?:me\s+)?(?:the\s+)?(.+)/i;
const INVESTIGATE = /\b(investigate|look into|dig into|what happened (?:with|to|on))\b/i;

export function parseIntent(text: string | null | undefined): Intent {
  const trimmed = (text ?? '').trim();

  // A message with no text is a photo, a voice note, or a sticker. Offering help is friendlier
  // than an error and is what a person would do.
  if (trimmed.length === 0) return { kind: 'help' };

  if (HELP.test(trimmed)) return { kind: 'help' };

  // Checked before the incident id, because "why did INC-481 happen?" is a follow-up about an
  // investigation already in the thread, not a request to start a second one.
  if (WHY.test(trimmed)) return { kind: 'why' };

  const incident = INCIDENT_ID.exec(trimmed);
  if (incident?.[1] && (INVESTIGATE.test(trimmed) || isBareIncidentId(trimmed))) {
    return { kind: 'investigate', incidentId: incident[1].toUpperCase() };
  }

  const show = SHOW.exec(trimmed);
  if (show?.[1]) return { kind: 'show', subject: normaliseSubject(show[1]) };

  return { kind: 'question', text: trimmed };
}

/** A message that is nothing but an incident id is unambiguously a request to investigate it. */
function isBareIncidentId(text: string): boolean {
  return INCIDENT_ID.test(text) && text.replace(INCIDENT_ID, '').trim().length === 0;
}

function normaliseSubject(subject: string): string {
  return subject
    .trim()
    .replace(/[?.!]+$/, '')
    .toLowerCase();
}
