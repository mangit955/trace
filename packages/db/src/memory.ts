import {
  buildEvidenceGraph,
  type CollectorRun,
  type CollectorRunRepository,
  type ConversationLinkRepository,
  type EvidenceEdge,
  type EvidenceGraph,
  type EvidenceNode,
  type EvidenceRepository,
  type ExternalRef,
  type FindSimilarInput,
  type Hypothesis,
  type HypothesisRepository,
  type IndexInvestigationInput,
  type Investigation,
  type InvestigationId,
  type InvestigationRepository,
  type InvestigationSimilarityRepository,
  type SimilarInvestigation,
  type TenantContext,
} from '@trace/domain';
import type { InvestigationReport, ReportRepository } from '@trace/reasoner';
import type { TraceStore } from './store.ts';

/**
 * In-memory implementations of every domain port.
 *
 * These are not a test double. They back the credential-free demo *and* the whole test suite, which
 * is the point of the domain defining its own repository interfaces: `bun run dev` gives a reviewer
 * a working agent with no database to install, and the suite runs in milliseconds against exactly
 * the same contracts Postgres will have to satisfy.
 *
 * Every method takes an explicit `TenantContext` and every read filters on it. There is no ambient
 * tenant anywhere in Trace, because a misplaced `orgId` is a data breach rather than a bug — so the
 * filtering is duplicated deliberately in each method rather than hidden in a shared helper that
 * one future method could forget to call.
 */

/**
 * The tenant/key separator.
 *
 * A NUL rather than a space or a colon, because it cannot occur in a UUID or in a Caspian
 * conversation id — so no caller can craft a key that reads as another tenant's. Written as a named
 * constant rather than typed inline: a literal NUL is *invisible* in an editor and makes the file
 * binary to `grep` and `ripgrep`, which silently skip it. Two of them were sitting in this file
 * unremarked, and the first hand-written `${orgId} ` prefix that used a space instead simply
 * matched nothing.
 */
const TENANT_SEPARATOR = String.fromCharCode(0);

/** Scopes a key to its tenant, so no lookup can cross an org boundary by construction. */
function scoped(ctx: TenantContext, key: string): string {
  return `${ctx.orgId}${TENANT_SEPARATOR}${key}`;
}

/**
 * Whether a scoped key belongs to this tenant, for the two lookups that must scan.
 *
 * Paired with `scoped` so the prefix is never written out by hand — writing it out is what turned a
 * missing tenant filter into a silently empty result rather than a loud failure.
 */
function belongsTo(ctx: TenantContext, key: string): boolean {
  return key.startsWith(`${ctx.orgId}${TENANT_SEPARATOR}`);
}

class MemoryInvestigations implements InvestigationRepository {
  readonly #byId = new Map<string, Investigation>();

  async save(ctx: TenantContext, investigation: Investigation): Promise<void> {
    // Copied on the way in and out: domain values are immutable, and a repository that handed back
    // the caller's own object would let a later mutation rewrite stored history.
    this.#byId.set(scoped(ctx, investigation.id), { ...investigation });
  }

  async findById(ctx: TenantContext, id: InvestigationId): Promise<Investigation | undefined> {
    const found = this.#byId.get(scoped(ctx, id));
    return found ? { ...found } : undefined;
  }

  async findByExternalRef(
    ctx: TenantContext,
    ref: ExternalRef,
  ): Promise<Investigation | undefined> {
    for (const [key, investigation] of this.#byId) {
      if (!belongsTo(ctx, key)) continue;
      if (
        investigation.externalRef.system === ref.system &&
        investigation.externalRef.id === ref.id
      ) {
        return { ...investigation };
      }
    }
    return undefined;
  }
}

class MemoryEvidence implements EvidenceRepository {
  readonly #nodes = new Map<string, EvidenceNode[]>();
  readonly #edges = new Map<string, EvidenceEdge[]>();

  async append(
    ctx: TenantContext,
    investigationId: InvestigationId,
    nodes: readonly EvidenceNode[],
    edges: readonly EvidenceEdge[],
  ): Promise<void> {
    const key = scoped(ctx, investigationId);

    // Append-only with deduplication on `dedupeKey`, never update: a citation made against a node
    // must resolve to the same content forever, so re-collection adds nothing it already holds.
    const existing = this.#nodes.get(key) ?? [];
    const seen = new Set(existing.map((node) => node.dedupeKey));
    for (const node of nodes) {
      if (seen.has(node.dedupeKey)) continue;
      seen.add(node.dedupeKey);
      existing.push(node);
    }
    this.#nodes.set(key, existing);

    const storedEdges = this.#edges.get(key) ?? [];
    const seenEdges = new Set(
      storedEdges.map((edge) => `${edge.from}|${edge.relation}|${edge.to}`),
    );
    for (const edge of edges) {
      const identity = `${edge.from}|${edge.relation}|${edge.to}`;
      if (seenEdges.has(identity)) continue;
      seenEdges.add(identity);
      storedEdges.push(edge);
    }
    this.#edges.set(key, storedEdges);
  }

  async loadGraph(ctx: TenantContext, investigationId: InvestigationId): Promise<EvidenceGraph> {
    const key = scoped(ctx, investigationId);

    // Rebuilt through the domain constructor rather than returned raw, so storage cannot hand back
    // a graph that violates the invariants the rest of the system relies on.
    return buildEvidenceGraph({
      investigationId,
      nodes: this.#nodes.get(key) ?? [],
      edges: this.#edges.get(key) ?? [],
    });
  }
}

class MemoryCollectorRuns implements CollectorRunRepository {
  readonly #runs = new Map<string, CollectorRun[]>();

  async save(ctx: TenantContext, run: CollectorRun): Promise<void> {
    const key = scoped(ctx, run.investigationId);
    const existing = this.#runs.get(key) ?? [];

    // A run is saved when it starts and again when it finishes, so this is an upsert by id.
    const index = existing.findIndex((candidate) => candidate.id === run.id);
    if (index === -1) existing.push({ ...run });
    else existing[index] = { ...run };

    this.#runs.set(key, existing);
  }

  async listFor(
    ctx: TenantContext,
    investigationId: InvestigationId,
  ): Promise<readonly CollectorRun[]> {
    return (this.#runs.get(scoped(ctx, investigationId)) ?? []).map((run) => ({ ...run }));
  }
}

class MemoryHypotheses implements HypothesisRepository {
  readonly #hypotheses = new Map<string, Hypothesis[]>();

  async save(ctx: TenantContext, hypothesis: Hypothesis): Promise<void> {
    const key = scoped(ctx, hypothesis.investigationId);
    const existing = this.#hypotheses.get(key) ?? [];
    existing.push({ ...hypothesis });
    this.#hypotheses.set(key, existing);
  }

  async listFor(
    ctx: TenantContext,
    investigationId: InvestigationId,
  ): Promise<readonly Hypothesis[]> {
    return (this.#hypotheses.get(scoped(ctx, investigationId)) ?? []).map((h) => ({ ...h }));
  }
}

class MemoryConversationLinks implements ConversationLinkRepository {
  readonly #links = new Map<string, InvestigationId>();

  async link(
    ctx: TenantContext,
    conversationId: string,
    investigationId: InvestigationId,
  ): Promise<void> {
    // Last write wins: a thread moves on to the next incident, and "why?" should mean the one
    // being discussed now.
    this.#links.set(scoped(ctx, conversationId), investigationId);
  }

  async resolve(ctx: TenantContext, conversationId: string): Promise<InvestigationId | undefined> {
    return this.#links.get(scoped(ctx, conversationId));
  }
}

/**
 * The report an engineer was shown, kept so a follow-up explains that report and not a fresh one.
 *
 * Reasoning is neither free nor deterministic, so regenerating it to answer "why?" would spend a
 * live model call and could justify a conclusion the user never saw.
 */
class MemoryReports implements ReportRepository {
  readonly #reports = new Map<string, InvestigationReport>();

  async save(ctx: TenantContext, report: InvestigationReport): Promise<void> {
    this.#reports.set(scoped(ctx, report.investigationId), report);
  }

  async findFor(
    ctx: TenantContext,
    investigationId: InvestigationId,
  ): Promise<InvestigationReport | undefined> {
    return this.#reports.get(scoped(ctx, investigationId));
  }
}

/**
 * "Has this happened before?", without pgvector.
 *
 * A linear scan with cosine similarity computed in JS. That is genuinely the right algorithm at
 * this size — an exact answer over a few hundred investigations costs less than an index would —
 * and it keeps this a real implementation rather than a stub, so the credential-free demo answers
 * the same question the Postgres deploy does.
 */
class MemorySimilarity implements InvestigationSimilarityRepository {
  readonly #vectors = new Map<
    string,
    { investigationId: InvestigationId; embedding: number[]; model: string }
  >();

  constructor(private readonly investigations: InvestigationRepository) {}

  async index(ctx: TenantContext, input: IndexInvestigationInput): Promise<void> {
    // One vector per investigation: re-indexing after a better summary replaces it rather than
    // adding a second neighbour for the same incident. Unlike evidence, an embedding is derived
    // data — nothing cites it, so nothing rots when it is recomputed.
    this.#vectors.set(scoped(ctx, input.investigationId), {
      investigationId: input.investigationId,
      embedding: [...input.embedding],
      model: input.model,
    });
  }

  async findSimilar(
    ctx: TenantContext,
    input: FindSimilarInput,
  ): Promise<readonly SimilarInvestigation[]> {
    const scored: SimilarInvestigation[] = [];

    for (const [key, entry] of this.#vectors) {
      if (!belongsTo(ctx, key)) continue;
      if (entry.investigationId === input.exclude) continue;
      // Two embedding models do not share a vector space, so a similarity across them is a
      // meaningless number that still sorts. Skipped rather than scored badly.
      if (entry.model !== input.model) continue;

      const investigation = await this.investigations.findById(ctx, entry.investigationId);
      // An embedding whose investigation is gone is not a result. Nothing deletes investigations
      // today, so this is a guard rather than a path.
      if (!investigation) continue;

      scored.push({
        investigationId: entry.investigationId,
        externalRef: investigation.externalRef,
        score: cosine(input.embedding, entry.embedding),
      });
    }

    // Ties broken by id so the same corpus always returns the same order — two incidents can
    // genuinely score identically, and a report that reshuffles between runs is unexplainable.
    scored.sort((a, b) => b.score - a.score || a.investigationId.localeCompare(b.investigationId));
    return scored.slice(0, input.limit);
  }
}

/**
 * Cosine similarity, mapped from [-1, 1] onto [0, 1].
 *
 * Matches what `1 - (a <=> b)` gives in pgvector, so a score means the same thing in both stores
 * and a threshold tuned against the demo still holds in production.
 */
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Cannot compare a ${a.length}-dimension embedding with a ${b.length}-dimension one; ` +
        'the embedding model changed without a reindex.',
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return (dot / magnitude + 1) / 2;
}

/** Every repository an investigation needs, sharing one process-local store. */
export class InMemoryStore implements TraceStore {
  readonly investigations: InvestigationRepository = new MemoryInvestigations();
  readonly evidence: EvidenceRepository = new MemoryEvidence();
  readonly collectorRuns: CollectorRunRepository = new MemoryCollectorRuns();
  readonly hypotheses: HypothesisRepository = new MemoryHypotheses();
  readonly conversations: ConversationLinkRepository = new MemoryConversationLinks();
  readonly reports: ReportRepository = new MemoryReports();
  readonly similarity: InvestigationSimilarityRepository = new MemorySimilarity(
    this.investigations,
  );
}
