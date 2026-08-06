-- Trace core schema.
--
-- Shape follows the domain, not the other way round: `packages/domain/src/entities` is the source
-- of truth and these tables store it. Two properties are enforced here rather than in code, because
-- a constraint holds against concurrent writers and a code path does not:
--
--   * evidence is deduplicated on `dedupe_key`, so re-collection cannot double a fact;
--   * an investigation is unique per external incident, so a webhook delivered three times
--     produces one investigation.
--
-- Every table carries `org_id`. There is no ambient tenant anywhere in Trace.

create table if not exists orgs (
  id          uuid primary key,
  created_at  timestamptz not null default now()
);

create table if not exists investigations (
  id               uuid primary key,
  org_id           uuid not null references orgs (id),
  external_system  text not null,
  external_id      text not null,
  status           text not null check (
                     status in ('pending', 'collecting', 'reasoning', 'ready', 'failed')
                   ),
  window_from      timestamptz not null,
  window_to        timestamptz not null,
  failure_reason   text,
  created_at       timestamptz not null,
  updated_at       timestamptz not null,

  -- The ingestion idempotency key. `findByExternalRef` is the lookup this exists for.
  constraint investigations_external_ref_unique
    unique (org_id, external_system, external_id),
  -- The domain refuses to construct an inverted window; the database refuses to hold one.
  constraint investigations_window_ordered check (window_to > window_from)
);

create index if not exists investigations_org_created_idx
  on investigations (org_id, created_at desc);

create table if not exists evidence_nodes (
  id                uuid primary key,
  org_id            uuid not null references orgs (id),
  investigation_id  uuid not null references investigations (id) on delete cascade,

  kind              text not null,
  kind_version      integer not null check (kind_version > 0),
  payload           jsonb not null,
  -- `kind@version:identity`, from the kind definition. Deduplication is on the logical identity
  -- rather than a content hash: identity is already the key, so there is no hash to collide.
  dedupe_key        text not null,

  connector         text not null,
  collector_run_id  uuid not null,
  source_url        text,

  -- Three clocks, because they genuinely disagree in production.
  occurred_at       timestamptz not null,
  observed_at       timestamptz,
  collected_at      timestamptz not null,

  -- Evidence is append-only. This is what makes re-collection idempotent under concurrency, where
  -- a read-then-insert in application code would not be.
  constraint evidence_nodes_dedupe_unique unique (investigation_id, dedupe_key)
);

-- Ordering is always by `occurred_at`, never `collected_at`: collection lag varies wildly between
-- sources, and ordering by fetch time routinely shows a deploy after the errors it caused.
create index if not exists evidence_nodes_timeline_idx
  on evidence_nodes (investigation_id, occurred_at);

-- For querying into payloads ("every deployment of payments-api") without a column per kind.
create index if not exists evidence_nodes_payload_idx
  on evidence_nodes using gin (payload);

create table if not exists evidence_edges (
  org_id            uuid not null references orgs (id),
  investigation_id  uuid not null references investigations (id) on delete cascade,
  from_node_id      uuid not null references evidence_nodes (id) on delete cascade,
  to_node_id        uuid not null references evidence_nodes (id) on delete cascade,
  -- Factual relations only. There is deliberately no CAUSED_BY: causation is a *claim*, and claims
  -- live in `hypotheses` where they carry confidence and citations a human can check. A causal edge
  -- here would let the reasoner write its conclusions back into the evidence it reasons over.
  relation          text not null check (
                      relation in ('DEPLOYED_TO', 'INTRODUCED_BY', 'EMITTED_BY',
                                   'PART_OF', 'PRECEDED', 'SIMILAR_TO')
                    ),

  -- The same identity the in-memory store deduplicates on. Two collectors reporting one relation
  -- must not read to the model as two independent observations.
  primary key (investigation_id, from_node_id, to_node_id, relation),
  constraint evidence_edges_not_self check (from_node_id <> to_node_id)
);

create table if not exists collector_runs (
  id                uuid primary key,
  org_id            uuid not null references orgs (id),
  investigation_id  uuid not null references investigations (id) on delete cascade,
  collector         text not null,
  status            text not null check (
                      status in ('running', 'succeeded', 'failed', 'skipped')
                    ),
  -- Zero from a successful run is itself a finding, and a reported gap.
  node_count        integer not null default 0 check (node_count >= 0),
  error             text,
  skipped_reason    text,
  started_at        timestamptz not null,
  finished_at       timestamptz
);

-- This table is the source of truth for "what we don't know". A model cannot introspect what it
-- was never shown, so missing information is computed from here and never generated.
create index if not exists collector_runs_investigation_idx
  on collector_runs (investigation_id, collector);

create table if not exists hypotheses (
  id                uuid primary key,
  org_id            uuid not null references orgs (id),
  investigation_id  uuid not null references investigations (id) on delete cascade,
  statement         text not null,
  -- double precision, not numeric: numeric comes back over the wire as a string, and a confidence
  -- that is silently a string fails zod at the boundary rather than rendering.
  confidence        double precision not null check (confidence between 0 and 1),

  -- Reproducibility. Without these, "why did it conclude that?" is unanswerable once the prompt
  -- or the model has moved on.
  model             text not null,
  prompt_version    text not null,
  -- Every node the model was shown, including the ones it chose not to cite.
  evidence_seen     uuid[] not null default '{}',
  created_at        timestamptz not null
);

create index if not exists hypotheses_investigation_idx
  on hypotheses (investigation_id, created_at);

create table if not exists hypothesis_citations (
  hypothesis_id  uuid not null references hypotheses (id) on delete cascade,
  -- Citation order is part of the claim: the first citation is the one a reader checks first.
  position       integer not null,
  -- The label as it appeared in the prompt (E7), so report and prompt agree.
  label          text not null,
  node_id        uuid not null references evidence_nodes (id) on delete cascade,
  stance         text not null check (stance in ('supports', 'contradicts')),

  primary key (hypothesis_id, position)
);

-- The report an engineer was actually shown, stored whole.
--
-- Reasoning is neither free nor deterministic: regenerating it to answer "why?" costs a live model
-- call and can return different hypotheses, which would mean explaining a conclusion nobody saw.
create table if not exists investigation_reports (
  investigation_id    uuid primary key references investigations (id) on delete cascade,
  org_id              uuid not null references orgs (id),
  summary             text not null,
  -- Ordered. The ranking is the reasoner's output, and the rows live in `hypotheses`.
  hypothesis_ids      uuid[] not null default '{}',
  -- Computed from the evidence graph and the collector runs respectively, never model output.
  timeline            jsonb not null default '[]',
  missing_information jsonb not null default '[]',
  suggested_questions jsonb not null default '[]',
  model               text not null,
  prompt_version      text not null,
  generated_at        timestamptz not null
);

-- The small piece of state that lets a bare "why?" resolve. Threading itself is Caspian's job.
create table if not exists conversation_links (
  org_id            uuid not null references orgs (id),
  conversation_id   text not null,
  investigation_id  uuid not null references investigations (id) on delete cascade,
  linked_at         timestamptz not null default now(),

  -- Last write wins: a thread moves on to the next incident, and "why?" should mean the one being
  -- discussed now.
  primary key (org_id, conversation_id)
);
