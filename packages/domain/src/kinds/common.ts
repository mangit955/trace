import { z } from 'zod';
import type { EvidenceKindDefinition } from '../registry.ts';

/** Shared building blocks for core evidence kinds. */

export const IsoDateTime = z.iso.datetime();
/** Names, ids, actors. Bounded because every string here can reach the reasoning prompt. */
export const ShortText = z.string().min(1).max(200);
export const Title = z.string().min(1).max(500);

/**
 * Identity helper that preserves payload type inference from the schema, so `identity`,
 * `summarize` and `timestamps` get a fully typed argument without restating the type.
 */
export function defineEvidenceKind<T>(
  definition: EvidenceKindDefinition<T>,
): EvidenceKindDefinition<T> {
  return definition;
}

/** Formats a signed percentage change the way an engineer scanning a timeline expects. */
export function formatChange(percent: number): string {
  const rounded = Math.round(percent);
  return rounded >= 0 ? `+${rounded}%` : `${rounded}%`;
}
