import type { Collector } from './collector.ts';

/**
 * Choosing which collectors an investigation runs.
 *
 * Trace ships in two modes and has to switch between them without a code change: seeded fixture
 * sources so a reviewer can run it with no credentials, and real connectors that take over as
 * their environment variables appear. The switch is per-source, not global — a deployment with a
 * GitHub token but no Datadog key should investigate real GitHub evidence alongside seeded
 * telemetry.
 */

export interface SelectCollectorsInput {
  /** Fixture sources, keyed by the system they stand in for. Absent in production. */
  seeded?: readonly Collector[];
  /** Real connectors. One replaces the seed of the same name once it is configured. */
  live: readonly Collector[];
}

/**
 * Resolves seeded and live collectors into the set to run.
 *
 * A live collector wins its name only when it can actually run. An unconfigured connector whose
 * seed is present is dropped rather than kept, because reporting "github was not consulted" beside
 * the GitHub evidence the seed provided is worse than saying nothing — it makes the gap list, the
 * one part of the report a reader is meant to trust unconditionally, wrong. An unconfigured
 * connector with no seed behind it is kept, so its absence is still stated.
 */
export function selectCollectors(input: SelectCollectorsInput): readonly Collector[] {
  const chosen = new Map<string, Collector>();

  for (const collector of input.seeded ?? []) chosen.set(collector.name, collector);

  for (const collector of input.live) {
    const configured = collector.unavailableReason?.() === undefined;
    if (configured || !chosen.has(collector.name)) chosen.set(collector.name, collector);
  }

  // Sorted so the composition root cannot make an investigation's shape depend on argument order.
  return [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
