import type { AnyEvidenceKindDefinition, EvidenceKindRegistry } from '../registry.ts';
import {
  commitKind,
  configChangeKind,
  deploymentKind,
  featureFlagChangeKind,
  pullRequestKind,
} from './change.ts';
import { pastIncidentKind, serviceKind } from './context.ts';
import { alertKind, logPatternKind, metricSeriesKind } from './signal.ts';

export {
  commitKind,
  configChangeKind,
  deploymentKind,
  featureFlagChangeKind,
  pullRequestKind,
} from './change.ts';
export { defineEvidenceKind } from './common.ts';
export { pastIncidentKind, serviceKind } from './context.ts';
export { alertKind, logPatternKind, MAX_METRIC_POINTS, metricSeriesKind } from './signal.ts';

/**
 * The evidence kinds Trace ships with.
 *
 * These get structured treatment in the reasoning prompt; plugin kinds degrade to their
 * `summarize()` output. Adding one here is a deliberate act — it widens the contract the reasoner
 * and every renderer must handle.
 */
export const CORE_KINDS: readonly AnyEvidenceKindDefinition[] = [
  alertKind,
  deploymentKind,
  pullRequestKind,
  commitKind,
  configChangeKind,
  featureFlagChangeKind,
  metricSeriesKind,
  logPatternKind,
  serviceKind,
  pastIncidentKind,
];

/** Registers every core kind. Call once during composition-root setup. */
export function registerCoreKinds(registry: EvidenceKindRegistry): void {
  for (const definition of CORE_KINDS) {
    registry.registerCore(definition);
  }
}
