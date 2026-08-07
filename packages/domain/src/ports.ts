import type { CollectorRun } from './entities/collector-run.ts';
import type { EvidenceEdge, EvidenceNode } from './entities/evidence.ts';
import type { Hypothesis } from './entities/hypothesis.ts';
import type { ExternalRef, Investigation } from './entities/investigation.ts';
import type { EvidenceGraph } from './graph.ts';
import type { InvestigationId, OrgId } from './ids.ts';

/**
 * Ports the domain depends on, implemented by adapters (in-memory for the demo and tests,
 * Postgres in production).
 *
 * Defined here rather than in the database package so dependencies point inwards: the domain
 * states what it needs, and storage conforms. That is what lets the entire test suite run against
 * an in-memory implementation in milliseconds, and lets `bun run dev` give a reviewer a working
 * agent with no database at all.
 */

/**
 * The tenant every operation is scoped to.
 *
 * Passed explicitly on every call rather than held in ambient state. A misplaced `orgId` in a
 * multi-tenant system is not a bug, it is a data breach — so it should be visible at every call
 * site and impossible to forget, not tucked into a global that a background job might inherit
 * from the wrong request.
 */
export interface TenantContext {
  readonly orgId: OrgId;
}

/** Time as a dependency, so investigations are reproducible and tests need no real clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface InvestigationRepository {
  save(ctx: TenantContext, investigation: Investigation): Promise<void>;
  findById(ctx: TenantContext, id: InvestigationId): Promise<Investigation | undefined>;
  /**
   * Looks up by the incident this mirrors.
   *
   * The idempotency key for ingestion: a webhook delivered three times must produce one
   * investigation, not three.
   */
  findByExternalRef(ctx: TenantContext, ref: ExternalRef): Promise<Investigation | undefined>;
}

export interface EvidenceRepository {
  /**
   * Appends evidence. Never updates — evidence is immutable, and re-collection is deduplicated on
   * `dedupeKey` rather than overwriting.
   */
  append(
    ctx: TenantContext,
    investigationId: InvestigationId,
    nodes: readonly EvidenceNode[],
    edges: readonly EvidenceEdge[],
  ): Promise<void>;
  loadGraph(ctx: TenantContext, investigationId: InvestigationId): Promise<EvidenceGraph>;
}

export interface CollectorRunRepository {
  save(ctx: TenantContext, run: CollectorRun): Promise<void>;
  /** Source of truth for missing information. See `missingInformationFrom`. */
  listFor(ctx: TenantContext, investigationId: InvestigationId): Promise<readonly CollectorRun[]>;
}

export interface HypothesisRepository {
  save(ctx: TenantContext, hypothesis: Hypothesis): Promise<void>;
  listFor(ctx: TenantContext, investigationId: InvestigationId): Promise<readonly Hypothesis[]>;
}

/**
 * "Has this happened before?" — nearest-neighbour lookup over investigation-level embeddings.
 *
 * The port takes a vector and returns neighbours; it never makes one. Embedding is a model
 * concern and lives behind `Embedder` in the reasoner, so storage stays free of the question of
 * which provider is configured — and the in-memory implementation stays a real implementation
 * rather than a stub that only Postgres can satisfy.
 *
 * Investigation-level rather than per-node: one vector per incident over affected services, error
 * signature and summary. Embedding every evidence node would cost far more and mostly retrieve
 * noise — two unrelated incidents both deployed something on a Tuesday.
 */
export interface SimilarInvestigation {
  investigationId: InvestigationId;
  externalRef: ExternalRef;
  /** Cosine similarity in [0, 1]. Higher is closer. */
  score: number;
}

export interface IndexInvestigationInput {
  investigationId: InvestigationId;
  embedding: readonly number[];
  /** The text the vector was made from, kept so a stale embedding is recognisable. */
  sourceText: string;
  model: string;
}

export interface FindSimilarInput {
  embedding: readonly number[];
  /**
   * The model that produced `embedding`. Required, and matched exactly.
   *
   * Two embedding models do not share a vector space, so a cosine similarity computed across them
   * is not a weak signal — it is a meaningless number that still sorts. An operator who adds
   * `GEMINI_API_KEY` to a deployment that had been indexing lexically ends up with both kinds in
   * one table, and without this filter a genuine precedent scores 0.49 against a query it should
   * have matched. Found by reading the scores in a live table, not by a test.
   *
   * The consequence is deliberate: after a model change, precedent goes quiet until incidents are
   * re-indexed. Silence is the right failure here — a wrong "we have seen this before" sends an
   * on-call engineer down a path that has nothing to do with the incident in front of them.
   */
  model: string;
  limit: number;
  /** The investigation being explained. It is trivially its own nearest neighbour. */
  exclude?: InvestigationId;
}

export interface InvestigationSimilarityRepository {
  index(ctx: TenantContext, input: IndexInvestigationInput): Promise<void>;
  findSimilar(
    ctx: TenantContext,
    input: FindSimilarInput,
  ): Promise<readonly SimilarInvestigation[]>;
}

/**
 * Maps a Caspian conversation to the investigation being discussed in it.
 *
 * This is what lets a bare "why?" resolve. Threading is per-channel and handled by Caspian; this
 * is the small piece of state Trace has to keep so a follow-up knows what it refers to.
 */
export interface ConversationLinkRepository {
  link(ctx: TenantContext, conversationId: string, investigationId: InvestigationId): Promise<void>;
  resolve(ctx: TenantContext, conversationId: string): Promise<InvestigationId | undefined>;
}
