-- "Has this happened before?" — investigation-level embeddings.
--
-- One vector per incident, over affected services + error signature + summary. Deliberately not per
-- evidence node: embedding every node would cost far more and mostly retrieve noise, because two
-- unrelated incidents both deployed something on a Tuesday.
--
-- Requires the `vector` extension. The compose file uses pgvector/pgvector:pg17, where it is
-- present; on a plain postgres image this migration fails loudly, which is the correct outcome —
-- a database that silently could not answer "have we seen this before" would be worse.

create extension if not exists vector;

create table if not exists investigation_embeddings (
  investigation_id  uuid primary key references investigations (id) on delete cascade,
  org_id            uuid not null references orgs (id),
  -- 768 for both backends. Gemini is asked for `outputDimensionality: 768` and the credential-free
  -- lexical embedder produces the same width, because one column cannot hold two.
  embedding         vector(768) not null,
  -- The text the vector was made from, so a stale embedding is recognisable rather than merely
  -- wrong — a summary that has since been re-reasoned leaves a vector nothing explains.
  source_text       text not null,
  model             text not null,
  created_at        timestamptz not null default now()
);

-- HNSW over cosine distance, matching `1 - (a <=> b)` in the query and the JS cosine in the
-- in-memory store, so a score means the same thing in both and a threshold tuned on the demo
-- still holds in production.
create index if not exists investigation_embeddings_ann_idx
  on investigation_embeddings using hnsw (embedding vector_cosine_ops);
