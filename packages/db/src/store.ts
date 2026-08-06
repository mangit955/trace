import type {
  CollectorRunRepository,
  ConversationLinkRepository,
  EvidenceRepository,
  HypothesisRepository,
  InvestigationRepository,
  InvestigationSimilarityRepository,
} from '@trace/domain';
import type { ReportRepository } from '@trace/reasoner';

/**
 * Every repository an investigation needs, in one place.
 *
 * Named as an interface rather than a class so the agent depends on the *shape* of a store and not
 * on which one it got. `InMemoryStore` and `PostgresStore` both satisfy it, which is what makes
 * `bun run dev` with no database and `docker compose up` with one the same code path — and what
 * lets a single contract test suite be run against both.
 *
 * The domain owns all but one of these interfaces (`packages/domain/src/ports.ts`); `ReportRepository`
 * lives with `InvestigationReport` in the reasoner. Neither package knows this type exists.
 */
export interface TraceStore {
  readonly investigations: InvestigationRepository;
  readonly evidence: EvidenceRepository;
  readonly collectorRuns: CollectorRunRepository;
  readonly hypotheses: HypothesisRepository;
  readonly conversations: ConversationLinkRepository;
  readonly reports: ReportRepository;
  readonly similarity: InvestigationSimilarityRepository;
}
