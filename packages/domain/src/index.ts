/**
 * `@trace/domain` — the shared language every other package speaks.
 *
 * Zod is the only runtime dependency. No HTTP client, no database driver, no framework, so this
 * package is importable from the agent, collectors, the reasoner, workers and a CLI alike.
 *
 * The two invariants worth knowing before using any of this:
 *
 *  1. **Evidence records observations; hypotheses record claims.** Evidence edges are factual
 *     (`PRECEDED`, `INTRODUCED_BY`); there is no `CAUSED_BY`. Causation lives in `Hypothesis`,
 *     which cites evidence by id.
 *  2. **Nothing reaches the model uncited.** `serializeForReasoning` labels evidence, and
 *     `validateCitations` rejects any output referencing a label that was not shown.
 */

export {
  assertGrounded,
  extractCitationLabels,
  HallucinatedCitationError,
  UngroundedClaimError,
  validateCitations,
} from './citations.ts';

export {
  CollectorRun,
  CollectorRunStatus,
  completeCollectorRun,
  failCollectorRun,
  missingInformationFrom,
  type StartCollectorRunInput,
  skipCollectorRun,
  startCollectorRun,
} from './entities/collector-run.ts';

export {
  type CreateEvidenceEdgeInput,
  type CreateEvidenceNodeInput,
  createEvidenceEdge,
  createEvidenceNode,
  EvidenceEdge,
  EvidenceNode,
  EvidenceRelation,
} from './entities/evidence.ts';

export {
  type CitationInput,
  CitationStance,
  type CreateHypothesisInput,
  createHypothesis,
  Hypothesis,
  HypothesisCitation,
} from './entities/hypothesis.ts';

export {
  type CreateInvestigationInput,
  createInvestigation,
  DEFAULT_FORWARD_MINUTES,
  DEFAULT_LOOKBACK_MINUTES,
  defaultWindowFor,
  ExternalRef,
  fail,
  IllegalTransitionError,
  Investigation,
  InvestigationStatus,
  isTerminal,
  TimeWindow,
  transition,
} from './entities/investigation.ts';

export {
  type BuildEvidenceGraphInput,
  buildEvidenceGraph,
  type EvidenceGraph,
  neighboursOf,
  nodesOfKind,
} from './graph.ts';

export {
  CollectorRunId,
  EvidenceNodeId,
  HypothesisId,
  InvestigationId,
  newId,
  OrgId,
  uuidv7,
} from './ids.ts';

export * from './kinds/index.ts';
export {
  type Clock,
  type CollectorRunRepository,
  type ConversationLinkRepository,
  type EvidenceRepository,
  type HypothesisRepository,
  type InvestigationRepository,
  systemClock,
  type TenantContext,
} from './ports.ts';
export {
  type AnyEvidenceKindDefinition,
  type EvidenceKindDefinition,
  EvidenceKindRegistry,
  type NodeTimes,
} from './registry.ts';
export {
  type SerializedEvidence,
  type SerializeOptions,
  serializeForReasoning,
} from './serialize.ts';
