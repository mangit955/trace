import type { EvidenceNodeId } from './ids.ts';

/**
 * Citation validation — the mechanism that keeps the AI honest.
 *
 * Trace's central claim is that every conclusion is backed by evidence. Prompt wording cannot
 * enforce that; models produce confident, plausible, entirely invented support when the real
 * evidence is thin. What *can* enforce it is a deterministic check on the way out: the serializer
 * gave each piece of evidence a short label, so any label the model cites either resolves to a
 * real node or the output is rejected.
 *
 * This is the difference between "we asked it nicely to cite sources" and "it cannot ship an
 * unsupported conclusion".
 */

/** Citations must be written as `[E7]`. See {@link extractCitationLabels} for why brackets. */
const CITATION_IN_PROSE = /\[(E\d+)]/gi;
const WELL_FORMED_LABEL = /^E\d+$/;

/** A citation pointing at evidence that was never collected. */
export class HallucinatedCitationError extends Error {
  constructor(
    readonly fabricated: readonly string[],
    readonly available: readonly string[],
  ) {
    const known = available.length > 0 ? available.join(', ') : 'none';
    super(
      `Output cites evidence that does not exist: ${fabricated.join(', ')}. ` +
        `Available evidence: ${known}.`,
    );
    this.name = 'HallucinatedCitationError';
  }
}

/** A conclusion asserted without citing any evidence. */
export class UngroundedClaimError extends Error {
  constructor(message = 'Claim cites no evidence; an uncited conclusion is a guess.') {
    super(message);
    this.name = 'UngroundedClaimError';
  }
}

function normalise(label: string): string {
  return label.trim().toUpperCase();
}

/**
 * Resolves citation labels to evidence node ids.
 *
 * Case is normalised because models are inconsistent about it, and that leniency costs nothing —
 * `e1` is unambiguously the same citation as `E1`. Malformed labels are *not* tolerated: if the
 * model invents a new citation syntax, we want to know rather than silently drop it.
 *
 * @throws {UngroundedClaimError} when nothing is cited.
 * @throws {HallucinatedCitationError} when a citation does not resolve.
 */
export function validateCitations(
  labels: readonly string[],
  idMap: ReadonlyMap<string, EvidenceNodeId>,
): ReadonlyMap<string, EvidenceNodeId> {
  if (labels.length === 0) {
    throw new UngroundedClaimError();
  }

  const normalised = labels.map(normalise);

  const malformed = normalised.filter((label) => !WELL_FORMED_LABEL.test(label));
  if (malformed.length > 0) {
    throw new HallucinatedCitationError(malformed, [...idMap.keys()]);
  }

  const fabricated = [...new Set(normalised.filter((label) => !idMap.has(label)))];
  if (fabricated.length > 0) {
    // Every bad label at once: fixing them one round-trip at a time is needlessly slow, and the
    // full list makes the failure obvious in a log.
    throw new HallucinatedCitationError(fabricated, [...idMap.keys()]);
  }

  const resolved = new Map<string, EvidenceNodeId>();
  for (const label of normalised) {
    const nodeId = idMap.get(label);
    if (nodeId !== undefined) resolved.set(label, nodeId);
  }
  return resolved;
}

/**
 * Pulls citation labels out of free-form prose, in order of first appearance.
 *
 * Brackets are required. Without them, `m5.E2` instance types, "Section E4" and any sentence
 * mentioning E-something would register as evidence — false positives that would make the
 * validator worse than useless, since they would let ungrounded prose pass as grounded.
 */
export function extractCitationLabels(text: string): readonly string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(CITATION_IN_PROSE)) {
    const label = match[1];
    if (label !== undefined) seen.add(normalise(label));
  }
  return [...seen];
}

/**
 * Asserts a piece of model prose is fully grounded in collected evidence.
 *
 * Used for conversational answers ("why?"), where the model writes free text rather than a
 * structured report. Structured output validates its citation array through
 * {@link validateCitations} directly.
 */
export function assertGrounded(text: string, idMap: ReadonlyMap<string, EvidenceNodeId>): void {
  validateCitations(extractCitationLabels(text), idMap);
}
