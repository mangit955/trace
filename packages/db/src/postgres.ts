import {
  buildEvidenceGraph,
  CollectorRun,
  type CollectorRunRepository,
  type ConversationLinkRepository,
  EvidenceEdge,
  type EvidenceGraph,
  EvidenceNode,
  type EvidenceRepository,
  type ExternalRef,
  type FindSimilarInput,
  Hypothesis,
  type HypothesisRepository,
  type IndexInvestigationInput,
  Investigation,
  InvestigationId,
  type InvestigationRepository,
  type InvestigationSimilarityRepository,
  type OrgId,
  type SimilarInvestigation,
  type TenantContext,
} from '@trace/domain';
import type { InvestigationReport, ReportRepository } from '@trace/reasoner';
import { SQL } from 'bun';
import { migrate } from './migrate.ts';
import type { TraceStore } from './store.ts';

/**
 * Postgres implementations of every domain port.
 *
 * These satisfy exactly the interfaces in `packages/domain/src/ports.ts` that the in-memory store
 * satisfies, and are held to it by the same contract suite — `describeStoreContract` runs against
 * both, so a behaviour one has and the other does not is a failing test rather than a production
 * surprise at 3am in the one mode nobody develops against.
 *
 * Two conventions run through the file:
 *
 *  1. **Every read filters on `org_id`, written out in each method.** Duplicated deliberately
 *     rather than hidden in a shared helper a future method could forget to call. A misplaced
 *     `orgId` is a data breach, not a bug.
 *  2. **Rows are parsed back through the domain's zod schemas, never cast.** A `timestamptz` that
 *     arrived as a string, a dropped column, a `numeric` confidence that came over the wire as
 *     text — each fails loudly here at the boundary instead of quietly three layers later inside a
 *     renderer. Casting would make storage the one place in Trace that trusts its input.
 */

/** Rows come back as plain objects; the shape is asserted by the zod parse, not by this alias. */
type Row = Record<string, unknown>;

class PostgresInvestigations implements InvestigationRepository {
  constructor(private readonly sql: SQL) {}

  async save(ctx: TenantContext, investigation: Investigation): Promise<void> {
    // An upsert: `runInvestigation` saves the same investigation at each state transition. The
    // conflict target is the id rather than the external ref, so a transition never turns into a
    // second row for the same incident.
    await this.sql`
      insert into investigations (
        id, org_id, external_system, external_id, status,
        window_from, window_to, failure_reason, created_at, updated_at
      ) values (
        ${investigation.id}, ${ctx.orgId},
        ${investigation.externalRef.system}, ${investigation.externalRef.id},
        ${investigation.status},
        ${investigation.window.from}, ${investigation.window.to},
        ${investigation.failureReason ?? null},
        ${investigation.createdAt}, ${investigation.updatedAt}
      )
      on conflict (id) do update set
        status = excluded.status,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
      where investigations.org_id = ${ctx.orgId}
    `;
  }

  async findById(ctx: TenantContext, id: InvestigationId): Promise<Investigation | undefined> {
    const rows = await this.sql`
      select * from investigations where org_id = ${ctx.orgId} and id = ${id}
    `;
    return rows.length > 0 ? toInvestigation(rows[0]) : undefined;
  }

  async findByExternalRef(
    ctx: TenantContext,
    ref: ExternalRef,
  ): Promise<Investigation | undefined> {
    // The ingestion idempotency key, backed by a unique index on exactly these three columns.
    const rows = await this.sql`
      select * from investigations
      where org_id = ${ctx.orgId}
        and external_system = ${ref.system}
        and external_id = ${ref.id}
    `;
    return rows.length > 0 ? toInvestigation(rows[0]) : undefined;
  }
}

function toInvestigation(row: Row): Investigation {
  return Investigation.parse({
    id: row['id'],
    orgId: row['org_id'],
    externalRef: { system: row['external_system'], id: row['external_id'] },
    status: row['status'],
    window: { from: row['window_from'], to: row['window_to'] },
    // `exactOptionalPropertyTypes`: an absent reason is an absent key, not an explicit undefined.
    ...(row['failure_reason'] === null ? {} : { failureReason: row['failure_reason'] }),
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  });
}

class PostgresEvidence implements EvidenceRepository {
  constructor(private readonly sql: SQL) {}

  async append(
    ctx: TenantContext,
    investigationId: InvestigationId,
    nodes: readonly EvidenceNode[],
    edges: readonly EvidenceEdge[],
  ): Promise<void> {
    if (nodes.length === 0 && edges.length === 0) return;

    // One transaction, so a crash between nodes and edges cannot leave an edge pointing at evidence
    // that was never written — `buildEvidenceGraph` would then refuse to load the investigation at
    // all, turning a partial write into total loss.
    await this.sql.begin(async (tx: SQL) => {
      for (const node of nodes) {
        // `do nothing` rather than `do update`: evidence is immutable and append-only. A citation
        // made against a node must resolve to the same content forever, so re-collection adds what
        // is new and silently keeps what it already holds. The unique constraint, not a prior read,
        // is what makes that hold under concurrent collectors.
        await tx`
          insert into evidence_nodes (
            id, org_id, investigation_id, kind, kind_version, payload, dedupe_key,
            connector, collector_run_id, source_url, occurred_at, observed_at, collected_at
          ) values (
            ${node.id}, ${ctx.orgId}, ${investigationId},
            ${node.kind}, ${node.kindVersion}, ${JSON.stringify(node.payload)}, ${node.dedupeKey},
            ${node.connector}, ${node.collectorRunId}, ${node.sourceUrl ?? null},
            ${node.occurredAt}, ${node.observedAt ?? null}, ${node.collectedAt}
          )
          on conflict (investigation_id, dedupe_key) do nothing
        `;
      }

      for (const edge of edges) {
        // Edges are deduplicated too, not only nodes. Phase 2 shipped green without this, so one
        // fact reported by two collectors printed twice and read to the model as two independent
        // observations.
        await tx`
          insert into evidence_edges (
            org_id, investigation_id, from_node_id, to_node_id, relation
          ) values (
            ${ctx.orgId}, ${investigationId}, ${edge.from}, ${edge.to}, ${edge.relation}
          )
          on conflict do nothing
        `;
      }
    });
  }

  async loadGraph(ctx: TenantContext, investigationId: InvestigationId): Promise<EvidenceGraph> {
    const nodeRows = await this.sql`
      select * from evidence_nodes
      where org_id = ${ctx.orgId} and investigation_id = ${investigationId}
    `;
    const edgeRows = await this.sql`
      select * from evidence_edges
      where org_id = ${ctx.orgId} and investigation_id = ${investigationId}
    `;

    // Rebuilt through the domain constructor rather than returned as selected, so ordering,
    // deduplication and the no-dangling-edge invariant hold regardless of what the database
    // returned or in what order. `order by` in SQL would only approximate `compareNodes`.
    return buildEvidenceGraph({
      investigationId,
      nodes: nodeRows.map(toEvidenceNode),
      edges: edgeRows.map(toEvidenceEdge),
    });
  }
}

function toEvidenceNode(row: Row): EvidenceNode {
  return EvidenceNode.parse({
    id: row['id'],
    orgId: row['org_id'],
    investigationId: row['investigation_id'],
    kind: row['kind'],
    kindVersion: row['kind_version'],
    payload: fromJson(row['payload']),
    dedupeKey: row['dedupe_key'],
    connector: row['connector'],
    collectorRunId: row['collector_run_id'],
    ...(row['source_url'] === null ? {} : { sourceUrl: row['source_url'] }),
    occurredAt: row['occurred_at'],
    ...(row['observed_at'] === null ? {} : { observedAt: row['observed_at'] }),
    collectedAt: row['collected_at'],
  });
}

function toEvidenceEdge(row: Row): EvidenceEdge {
  return EvidenceEdge.parse({
    orgId: row['org_id'],
    investigationId: row['investigation_id'],
    from: row['from_node_id'],
    to: row['to_node_id'],
    relation: row['relation'],
  });
}

class PostgresCollectorRuns implements CollectorRunRepository {
  constructor(private readonly sql: SQL) {}

  async save(ctx: TenantContext, run: CollectorRun): Promise<void> {
    // Saved when it starts and again when it finishes, so this is an upsert by id. Two rows would
    // report one collector as both running and succeeded — and "did not finish in time" is a
    // stated gap in the report.
    await this.sql`
      insert into collector_runs (
        id, org_id, investigation_id, collector, status,
        node_count, error, skipped_reason, started_at, finished_at
      ) values (
        ${run.id}, ${ctx.orgId}, ${run.investigationId}, ${run.collector}, ${run.status},
        ${run.nodeCount}, ${run.error ?? null}, ${run.skippedReason ?? null},
        ${run.startedAt}, ${run.finishedAt ?? null}
      )
      on conflict (id) do update set
        status = excluded.status,
        node_count = excluded.node_count,
        error = excluded.error,
        skipped_reason = excluded.skipped_reason,
        finished_at = excluded.finished_at
      where collector_runs.org_id = ${ctx.orgId}
    `;
  }

  async listFor(
    ctx: TenantContext,
    investigationId: InvestigationId,
  ): Promise<readonly CollectorRun[]> {
    const rows = await this.sql`
      select * from collector_runs
      where org_id = ${ctx.orgId} and investigation_id = ${investigationId}
      order by collector, started_at
    `;
    return rows.map(toCollectorRun);
  }
}

function toCollectorRun(row: Row): CollectorRun {
  return CollectorRun.parse({
    id: row['id'],
    orgId: row['org_id'],
    investigationId: row['investigation_id'],
    collector: row['collector'],
    status: row['status'],
    nodeCount: row['node_count'],
    ...(row['error'] === null ? {} : { error: row['error'] }),
    ...(row['skipped_reason'] === null ? {} : { skippedReason: row['skipped_reason'] }),
    startedAt: row['started_at'],
    ...(row['finished_at'] === null ? {} : { finishedAt: row['finished_at'] }),
  });
}

class PostgresHypotheses implements HypothesisRepository {
  constructor(private readonly sql: SQL) {}

  async save(ctx: TenantContext, hypothesis: Hypothesis): Promise<void> {
    await saveHypothesis(this.sql, ctx, hypothesis);
  }

  async listFor(
    ctx: TenantContext,
    investigationId: InvestigationId,
  ): Promise<readonly Hypothesis[]> {
    const rows = await this.sql`
      select * from hypotheses
      where org_id = ${ctx.orgId} and investigation_id = ${investigationId}
      order by created_at, id
    `;
    return loadCitationsInto(this.sql, rows);
  }
}

/**
 * Writes a hypothesis and its citations together.
 *
 * Shared with the report repository, which upserts the hypotheses a report carries so a stored
 * report can never dangle an id it lists. In one transaction because a hypothesis without its
 * citations is precisely the ungrounded claim the domain makes unrepresentable — storage must not
 * be able to produce one that the constructor could not.
 */
async function saveHypothesis(sql: SQL, ctx: TenantContext, hypothesis: Hypothesis): Promise<void> {
  await sql.begin(async (tx: SQL) => {
    await tx`
      insert into hypotheses (
        id, org_id, investigation_id, statement, confidence,
        model, prompt_version, evidence_seen, created_at
      ) values (
        ${hypothesis.id}, ${ctx.orgId}, ${hypothesis.investigationId},
        ${hypothesis.statement}, ${hypothesis.confidence},
        ${hypothesis.model}, ${hypothesis.promptVersion},
        ${toUuidArray(hypothesis.evidenceSeen)}::uuid[], ${hypothesis.createdAt}
      )
      on conflict (id) do nothing
    `;

    for (const [position, citation] of hypothesis.citations.entries()) {
      // Position is what preserves order: the first citation is the one a reader checks first.
      await tx`
        insert into hypothesis_citations (hypothesis_id, position, label, node_id, stance)
        values (${hypothesis.id}, ${position}, ${citation.label}, ${citation.nodeId},
                ${citation.stance})
        on conflict (hypothesis_id, position) do nothing
      `;
    }
  });
}

/** Attaches citations to hypothesis rows in one further query, rather than one per hypothesis. */
async function loadCitationsInto(sql: SQL, rows: Row[]): Promise<readonly Hypothesis[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row['id'] as string);
  const citationRows = await sql`
    select * from hypothesis_citations
    where hypothesis_id in ${sql(ids)}
    order by hypothesis_id, position
  `;

  const byHypothesis = new Map<string, Row[]>();
  for (const row of citationRows) {
    const key = row['hypothesis_id'] as string;
    byHypothesis.set(key, [...(byHypothesis.get(key) ?? []), row]);
  }

  return rows.map((row) =>
    Hypothesis.parse({
      id: row['id'],
      orgId: row['org_id'],
      investigationId: row['investigation_id'],
      statement: row['statement'],
      confidence: row['confidence'],
      citations: (byHypothesis.get(row['id'] as string) ?? []).map((citation) => ({
        label: citation['label'],
        nodeId: citation['node_id'],
        stance: citation['stance'],
      })),
      model: row['model'],
      promptVersion: row['prompt_version'],
      evidenceSeen: fromUuidArray(row['evidence_seen']),
      createdAt: row['created_at'],
    }),
  );
}

class PostgresConversationLinks implements ConversationLinkRepository {
  constructor(private readonly sql: SQL) {}

  async link(
    ctx: TenantContext,
    conversationId: string,
    investigationId: InvestigationId,
  ): Promise<void> {
    // Last write wins: a thread moves on to the next incident, and "why?" should mean the one being
    // discussed now.
    await this.sql`
      insert into conversation_links (org_id, conversation_id, investigation_id, linked_at)
      values (${ctx.orgId}, ${conversationId}, ${investigationId}, now())
      on conflict (org_id, conversation_id) do update set
        investigation_id = excluded.investigation_id,
        linked_at = excluded.linked_at
    `;
  }

  async resolve(ctx: TenantContext, conversationId: string): Promise<InvestigationId | undefined> {
    const rows = await this.sql`
      select investigation_id from conversation_links
      where org_id = ${ctx.orgId} and conversation_id = ${conversationId}
    `;
    return rows.length > 0 ? InvestigationId.parse(rows[0]['investigation_id']) : undefined;
  }
}

/** A timeline entry as jsonb holds it: identical to `TimelineEntry` but for `at`, which loses its type. */
type StoredTimelineEntry = Omit<InvestigationReport['timeline'][number], 'at'> & { at: string };

class PostgresReports implements ReportRepository {
  constructor(private readonly sql: SQL) {}

  async save(ctx: TenantContext, report: InvestigationReport): Promise<void> {
    // The hypotheses are upserted here as well as by the caller. Belt and braces on purpose: a
    // report that listed an id no row backed would read back as a report with fewer conclusions
    // than the engineer was shown, which is the one thing this table exists to prevent.
    for (const hypothesis of report.hypotheses) {
      await saveHypothesis(this.sql, ctx, hypothesis);
    }

    await this.sql`
      insert into investigation_reports (
        investigation_id, org_id, summary, hypothesis_ids,
        timeline, missing_information, suggested_questions,
        model, prompt_version, generated_at
      ) values (
        ${report.investigationId}, ${ctx.orgId}, ${report.summary},
        ${toUuidArray(report.hypotheses.map((h) => h.id))}::uuid[],
        ${JSON.stringify(report.timeline)},
        ${JSON.stringify(report.missingInformation)},
        ${JSON.stringify(report.suggestedQuestions)},
        ${report.model}, ${report.promptVersion}, ${report.generatedAt}
      )
      on conflict (investigation_id) do update set
        summary = excluded.summary,
        hypothesis_ids = excluded.hypothesis_ids,
        timeline = excluded.timeline,
        missing_information = excluded.missing_information,
        suggested_questions = excluded.suggested_questions,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        generated_at = excluded.generated_at
      where investigation_reports.org_id = ${ctx.orgId}
    `;
  }

  async findFor(
    ctx: TenantContext,
    investigationId: InvestigationId,
  ): Promise<InvestigationReport | undefined> {
    const rows = await this.sql`
      select * from investigation_reports
      where org_id = ${ctx.orgId} and investigation_id = ${investigationId}
    `;
    if (rows.length === 0) return undefined;

    const row = rows[0];
    const ids = fromUuidArray(row['hypothesis_ids']);

    const hypothesisRows =
      ids.length === 0
        ? []
        : await this.sql`
            select * from hypotheses where org_id = ${ctx.orgId} and id in ${this.sql(ids)}
          `;
    const hypotheses = await loadCitationsInto(this.sql, hypothesisRows);

    // Restored in the order the reasoner ranked them, not the order the rows came back in. The
    // ranking is part of the report: the first hypothesis is the one an engineer acts on.
    const byId = new Map(hypotheses.map((h) => [String(h.id), h]));
    const ordered = ids.flatMap((id) => {
      const found = byId.get(id);
      return found ? [found] : [];
    });

    return {
      investigationId: InvestigationId.parse(row['investigation_id']),
      orgId: row['org_id'] as OrgId,
      summary: row['summary'] as string,
      hypotheses: ordered,
      timeline: (fromJson(row['timeline']) as StoredTimelineEntry[]).map((entry) => ({
        ...entry,
        // jsonb has no date type, so a timeline entry's `at` comes back as an ISO string. The
        // renderer formats it as a time; a string would render as the literal ISO text.
        at: new Date(entry.at),
      })),
      missingInformation: fromJson(row['missing_information']) as string[],
      suggestedQuestions: fromJson(row['suggested_questions']) as string[],
      model: row['model'] as string,
      promptVersion: row['prompt_version'] as string,
      generatedAt: row['generated_at'] as Date,
    };
  }
}

class PostgresSimilarity implements InvestigationSimilarityRepository {
  constructor(private readonly sql: SQL) {}

  async index(ctx: TenantContext, input: IndexInvestigationInput): Promise<void> {
    // One vector per investigation. An embedding is derived data — nothing cites it — so unlike
    // evidence it is replaced rather than appended when a better summary comes along.
    await this.sql`
      insert into investigation_embeddings (
        investigation_id, org_id, embedding, source_text, model
      ) values (
        ${input.investigationId}, ${ctx.orgId}, ${toVector(input.embedding)}::vector,
        ${input.sourceText}, ${input.model}
      )
      on conflict (investigation_id) do update set
        embedding = excluded.embedding,
        source_text = excluded.source_text,
        model = excluded.model,
        created_at = now()
      where investigation_embeddings.org_id = ${ctx.orgId}
    `;
  }

  async findSimilar(
    ctx: TenantContext,
    input: FindSimilarInput,
  ): Promise<readonly SimilarInvestigation[]> {
    const rows = await this.sql`
      select
        e.investigation_id,
        i.external_system,
        i.external_id,
        1 - (e.embedding <=> ${toVector(input.embedding)}::vector) as distance_score
      from investigation_embeddings e
      join investigations i on i.id = e.investigation_id and i.org_id = e.org_id
      where e.org_id = ${ctx.orgId}
        -- The investigation being explained is trivially its own nearest neighbour. Written as a
        -- null-tolerant comparison so the same query serves both callers.
        and (${input.exclude ?? null}::uuid is null or e.investigation_id <> ${input.exclude ?? null}::uuid)
      order by e.embedding <=> ${toVector(input.embedding)}::vector, e.investigation_id
      limit ${input.limit}
    `;

    return rows.map((row: Row) => ({
      investigationId: InvestigationId.parse(row['investigation_id']),
      externalRef: {
        system: row['external_system'] as string,
        id: row['external_id'] as string,
      },
      // pgvector's cosine *distance* is in [0, 2]; `1 - distance` is the similarity in [-1, 1].
      // Mapped onto [0, 1] to match the in-memory store, so a threshold means the same thing in
      // both and the demo and production do not disagree about what "similar" is.
      score: (Number(row['distance_score']) + 1) / 2,
    }));
  }
}

/**
 * Renders an embedding for pgvector.
 *
 * The bracketed text form with an explicit `::vector` cast, because Bun serialises a JS `number[]`
 * as a Postgres *array* literal (`{1,2,3}`) — which pgvector rejects. Silent-looking detail, loud
 * failure: without it every insert errors on type mismatch.
 */
function toVector(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Renders a list of ids as a Postgres `uuid[]` literal.
 *
 * Same reason as `toVector`, found the same way — by running it. Bun expands a bound JS array into
 * a *value list* (what `in ${sql(ids)}` needs), so binding one straight into a `uuid[]` column
 * sends the bare element and Postgres answers `malformed array literal`. A single-element array
 * fails identically to a ten-element one, so no amount of in-memory testing would have shown this.
 */
function toUuidArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

/**
 * Reads a `uuid[]` column back.
 *
 * The other half of the same surprise: Bun hands array columns back as the raw Postgres literal
 * `{a,b}` rather than as a JS array, so `evidenceSeen` arrived as a string and failed zod at the
 * boundary — which is exactly what parsing rather than casting is for. `Array.isArray` first, so
 * this keeps working if a future Bun starts decoding them properly.
 */
/**
 * Reads a `jsonb` column back.
 *
 * Bun returns jsonb as the raw text too, so an evidence payload arrived as a string and a stored
 * timeline as something with no `.map`. Third instance of one lesson, all three found by running
 * against a real server: **Bun's SQL client decodes scalars, not composite types.** Guarded with
 * `typeof` so a future Bun that decodes them properly needs no change here.
 */
function fromJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function fromUuidArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string') return [];

  const inner = value.replace(/^\{|\}$/g, '');
  return inner.length === 0 ? [] : inner.split(',');
}

/**
 * Every repository an investigation needs, over one connection pool.
 *
 * `connect` migrates and ensures the org row before returning, so `docker compose up` followed by
 * `bun start` is the whole setup — there is no second command an operator can forget, and no
 * window in which the agent is running against a schema that does not exist yet.
 */
export class PostgresStore implements TraceStore {
  private constructor(
    readonly sql: SQL,
    readonly investigations: InvestigationRepository,
    readonly evidence: EvidenceRepository,
    readonly collectorRuns: CollectorRunRepository,
    readonly hypotheses: HypothesisRepository,
    readonly conversations: ConversationLinkRepository,
    readonly reports: ReportRepository,
    readonly similarity: InvestigationSimilarityRepository,
  ) {}

  static async connect(url: string, orgIds: readonly OrgId[] = []): Promise<PostgresStore> {
    const sql = new SQL(url);
    await migrate(sql);
    for (const orgId of orgIds) await ensureOrg(sql, orgId);

    return new PostgresStore(
      sql,
      new PostgresInvestigations(sql),
      new PostgresEvidence(sql),
      new PostgresCollectorRuns(sql),
      new PostgresHypotheses(sql),
      new PostgresConversationLinks(sql),
      new PostgresReports(sql),
      new PostgresSimilarity(sql),
    );
  }

  /** Registers a tenant. Every other table has a foreign key to this one. */
  async ensureOrg(orgId: OrgId): Promise<void> {
    await ensureOrg(this.sql, orgId);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

async function ensureOrg(sql: SQL, orgId: OrgId): Promise<void> {
  await sql`insert into orgs (id) values (${orgId}) on conflict (id) do nothing`;
}
