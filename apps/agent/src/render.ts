import type { InvestigationReport } from '@trace/reasoner';
import type { Block } from 'caspian-sdk';
import type { Reply } from './message.ts';

/**
 * Turning a report into something a human reads on their phone at 3am.
 *
 * Notably, this does not look at `message.channel` — nothing in Trace does. Caspian's `Block[]` is
 * provider-neutral: the gateway renders it natively on Slack, Discord and Telegram and degrades it
 * to clean text everywhere else. So rather than one renderer per platform — which the challenge
 * explicitly does not count, and which would rot — every reply carries **both** a plain text
 * rendering and the blocks, and the channel decides which it can show.
 *
 * The plain text is written to survive the worst channel in the set: no markdown, hard length caps,
 * no links. That constraint is why nothing here uses `*bold*` or `# headings` — on X or SMS those
 * are literal characters wasting a 300-character budget.
 */

/** Long enough to be useful, short enough to read on a phone without scrolling forever. */
const TIMELINE_LINES = 12;

/** Below this, abridging costs more in hidden evidence than it saves in length. */
const MIN_WORTH_ELIDING = 3;

/**
 * Shortens a long timeline from the **middle**.
 *
 * An incident timeline is not a list where the tail is expendable — it culminates. The change that
 * caused it sorts near the start and the alert it triggered sorts at the very end, so cutting the
 * last entries hides both the cause and the symptom the summary is discussing. Dropping from the
 * middle keeps the shape of the story: what changed, then what broke.
 */
function abridge<T>(entries: readonly T[]): { shown: T[]; omitted: number; breakAfter: number } {
  // Eliding one or two entries buys the reader nothing and risks hiding the change that caused the
  // incident, so the cut only happens when it actually saves something worth saving.
  if (entries.length <= TIMELINE_LINES + MIN_WORTH_ELIDING) {
    return { shown: [...entries], omitted: 0, breakAfter: -1 };
  }

  const head = Math.ceil(TIMELINE_LINES / 2);
  const tail = TIMELINE_LINES - head;

  return {
    shown: [...entries.slice(0, head), ...entries.slice(-tail)],
    omitted: entries.length - TIMELINE_LINES,
    breakAfter: head,
  };
}

/**
 * A prior investigation this one resembles.
 *
 * Passed alongside the report rather than added to `InvestigationReport`, deliberately. A report is
 * the model's output plus computed facts, and every claim in it cites evidence; precedent is
 * neither — it is a nearest-neighbour lookup in storage. Putting it inside the report type would
 * blur the line between "what the reasoner concluded" and "what the database happens to hold, with
 * no citation behind it".
 */
export interface Precedent {
  incidentId: string;
  /** Cosine similarity in [0, 1]. Shown, not hidden: an 0.62 match deserves to look like one. */
  score: number;
}

export function renderReport(
  report: InvestigationReport,
  incidentId: string,
  precedents: readonly Precedent[] = [],
): Reply {
  const leading = report.hypotheses[0];

  const lines = [`${incidentId} — what I found`, '', report.summary, ''];

  if (leading) {
    lines.push(`Most likely (${percent(leading.confidence)}): ${leading.statement}`);
    lines.push(`Evidence: ${leading.citations.map((c) => c.label).join(', ')}`);
    lines.push('');
  }

  const timeline = abridge(report.timeline);
  lines.push('Timeline:');
  timeline.shown.forEach((entry, index) => {
    if (index === timeline.breakAfter) {
      lines.push(`  … ${timeline.omitted} further events …`);
    }
    lines.push(`  ${time(entry.at)}  [${entry.label}] ${entry.summary}`);
  });
  lines.push('');

  // Never omitted. A reader has no way to tell an empty gap list from an unasked question, and
  // "what we could not see" is the part of the report they cannot verify themselves.
  if (report.missingInformation.length > 0) {
    lines.push('What I could not see:');
    for (const gap of report.missingInformation) lines.push(`  - ${gap}`);
  } else {
    lines.push('No blind spots: every source reported.');
  }

  // Stated as resemblance, never as cause. "We have seen this shape before" is a retrieval result,
  // and phrasing it as a finding would smuggle an uncited claim into a report where everything else
  // is either cited or computed.
  if (precedents.length > 0) {
    lines.push('');
    lines.push('Similar past investigations:');
    for (const precedent of precedents) {
      lines.push(`  - ${precedent.incidentId} (${percent(precedent.score)} similar)`);
    }
  }

  lines.push('');
  // Names the model verbatim, which for the credential-free demo reads "(replayed)". A report
  // that let a recording pass for live reasoning would misrepresent itself to a reviewer.
  //
  // With no hypotheses there was no reasoning, so "Reasoned by" would be a small lie in the one
  // place the report is admitting a limitation. The model string says what happened by itself.
  lines.push(leading ? `Reasoned by ${report.model}` : report.model);

  return { text: lines.join('\n'), blocks: reportBlocks(report, incidentId, precedents) };
}

function reportBlocks(
  report: InvestigationReport,
  incidentId: string,
  precedents: readonly Precedent[],
): Block[] {
  const leading = report.hypotheses[0];

  const blocks: Block[] = [
    { type: 'heading', text: `${incidentId} — what I found` },
    { type: 'text', text: report.summary },
  ];

  if (leading) {
    blocks.push({
      type: 'fields',
      fields: [
        { label: 'Most likely cause', value: leading.statement },
        { label: 'Confidence', value: percent(leading.confidence) },
        { label: 'Cited evidence', value: leading.citations.map((c) => c.label).join(', ') },
      ],
    });
  }

  blocks.push({ type: 'divider' });
  const timeline = abridge(report.timeline);
  blocks.push({
    type: 'list',
    items: timeline.shown.flatMap((entry, index) => [
      ...(index === timeline.breakAfter ? [`… ${timeline.omitted} further events …`] : []),
      `${time(entry.at)} [${entry.label}] ${entry.summary}`,
    ]),
  });

  if (report.missingInformation.length > 0) {
    blocks.push({
      type: 'fields',
      fields: report.missingInformation.map((gap, index) => ({
        label: index === 0 ? 'Not seen' : ' ',
        value: gap,
      })),
    });
  }

  if (precedents.length > 0) {
    blocks.push({
      type: 'fields',
      fields: precedents.map((precedent, index) => ({
        label: index === 0 ? 'Seen before' : ' ',
        value: `${precedent.incidentId} (${percent(precedent.score)} similar)`,
      })),
    });
  }

  const buttons = evidenceButtons(report);
  // A callback button rather than a link: the reasoning lives in this conversation, and tapping it
  // should continue the thread rather than open a browser.
  buttons.push({ label: 'Why?', value: 'why' });
  blocks.push({ type: 'buttons', buttons });

  return blocks;
}

/**
 * Deep links to the evidence itself.
 *
 * "Here is the evidence for that conclusion" is only worth anything if the reader can open it, so
 * these come from `TimelineEntry.sourceUrl`, which the evidence kind derived from the payload — a
 * real deploy, a real PR, a real incident. Nothing here is constructed or guessed.
 */
function evidenceButtons(report: InvestigationReport): Block['buttons'] & object {
  const labelFor: Record<string, string> = {
    deployment: 'View deploy',
    pull_request: 'View PR',
    commit: 'View commit',
    alert: 'View alert',
    past_incident: 'Past incident',
  };

  const seen = new Set<string>();
  const buttons: NonNullable<Block['buttons']> = [];

  for (const entry of report.timeline) {
    if (!entry.sourceUrl) continue;
    const label = labelFor[entry.kind];
    if (!label || seen.has(label)) continue;
    seen.add(label);
    buttons.push({ label, url: entry.sourceUrl });
  }

  return buttons;
}

export function renderReasoning(report: InvestigationReport | undefined): Reply {
  if (!report) {
    return {
      text: 'I am not investigating anything in this conversation yet. Which incident? Try "investigate INC-481".',
    };
  }

  // No hypotheses means reasoning failed and the report is the bare reconstruction. Printing the
  // usual header over nothing at all reads as a broken bot; the report's own summary already says
  // exactly what went wrong, so repeat it rather than invent a second explanation.
  if (report.hypotheses.length === 0) {
    return {
      text: `I have no reasoning to show for this one.\n\n${report.summary}`,
      blocks: [
        { type: 'heading', text: 'Reasoning' },
        { type: 'text', text: `I have no reasoning to show for this one. ${report.summary}` },
      ],
    };
  }

  const lines = ['Here is my reasoning, and the evidence behind it.', ''];

  for (const hypothesis of report.hypotheses) {
    lines.push(`${percent(hypothesis.confidence)} — ${hypothesis.statement}`);
    const supports = hypothesis.citations.filter((c) => c.stance === 'supports');
    const against = hypothesis.citations.filter((c) => c.stance === 'contradicts');
    if (supports.length > 0)
      lines.push(`  supported by: ${supports.map((c) => c.label).join(', ')}`);
    // Surfaced deliberately: evidence that argues against a theory is the most useful thing in a
    // report, and the easiest for a hurried reader to miss.
    if (against.length > 0)
      lines.push(`  argues against: ${against.map((c) => c.label).join(', ')}`);
    lines.push('');
  }

  if (report.suggestedQuestions.length > 0) {
    lines.push('Worth asking next:');
    for (const question of report.suggestedQuestions) lines.push(`  - ${question}`);
  }

  return {
    text: lines.join('\n').trimEnd(),
    blocks: [
      { type: 'heading', text: 'Reasoning' },
      {
        type: 'fields',
        fields: report.hypotheses.map((hypothesis) => ({
          label: percent(hypothesis.confidence),
          value: `${hypothesis.statement} (${hypothesis.citations.map((c) => c.label).join(', ')})`,
        })),
      },
    ],
  };
}

/**
 * What Trace can do.
 *
 * `note` explains why the user is seeing this instead of what they asked for, and is only ever
 * passed for a *configuration* gap. A failure that is a safety property — an answer rejected for
 * citing evidence nobody collected — deliberately gets no note: naming a credential there would
 * imply that setting one makes the ungrounded answer appear.
 */
export function renderHelp(note?: string): Reply {
  const lines = [
    ...(note ? [note, ''] : []),
    'I reconstruct what happened during an incident. I do not fix anything.',
    '',
    'Try:',
    '  investigate INC-481   - reconstruct an incident',
    '  why                   - the reasoning, with the evidence behind it',
    '  show deploy           - a specific piece of evidence',
    '',
    'Or just ask me a question about the incident we are discussing.',
  ];

  return {
    text: lines.join('\n'),
    blocks: [
      { type: 'heading', text: 'Trace' },
      ...(note ? [{ type: 'text' as const, text: note }] : []),
      {
        type: 'text',
        text: 'I reconstruct what happened during an incident. I do not fix anything.',
      },
      {
        type: 'list',
        items: [
          'investigate INC-481 — reconstruct an incident',
          'why — the reasoning, with the evidence behind it',
          'show deploy — a specific piece of evidence',
        ],
      },
    ],
  };
}

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** Times only: an incident timeline spans minutes, and the date is in the report header. */
function time(at: Date): string {
  return at.toISOString().slice(11, 19);
}
