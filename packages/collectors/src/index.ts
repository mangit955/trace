/**
 * `@trace/collectors` — the sources an investigation is reconstructed from.
 *
 * A collector proposes structured evidence for one system; the runner turns proposals into a
 * validated graph. The contract that matters is the failure contract: a collector that throws,
 * hangs, or was never configured produces a recorded gap and nothing more. An investigation is
 * never failed by one of its sources.
 *
 * Seeded fixture incidents live behind `@trace/collectors/fixtures` so the demo path is an
 * explicit import rather than something that could be reached by accident in production.
 */

export {
  type Collector,
  type CollectorContext,
  type CollectorResult,
  draft,
  type EvidenceDraft,
  evidenceKey,
  keyOf,
  type RelationDraft,
} from './collector.ts';
export { type SelectCollectorsInput, selectCollectors } from './compose.ts';
export {
  type GitHubCollectorOptions,
  type GitHubEnv,
  githubCollector,
  githubCollectorFromEnv,
} from './github.ts';
export {
  type CollectEvidenceInput,
  type CollectionResult,
  collectEvidence,
  DEFAULT_COLLECTOR_TIMEOUT_MS,
} from './runner.ts';
