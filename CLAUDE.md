# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Trace is

An AI incident investigation agent. It reconstructs what happened during a production incident —
what changed, who deployed, what broke first, whether it has happened before — and answers
follow-up questions, with every claim backed by cited evidence. It does **not** fix incidents.

Engineers reach it through **Caspian**, which is the communication layer: one identity, one
handler, across Telegram and Slack.

`TODO.md` is the working plan: phases, locked decisions, and the invariants below. Read it before
starting work and tick items off as you go.

## Commands

```bash
bun install
bun test                                       # whole suite
bun test packages/domain/src/graph.test.ts     # one file
bun test --test-name-pattern "never drops"     # one test by name
bun run typecheck                              # tsc across all workspaces
bun run lint                                   # biome check
bun run format                                 # biome check --write (also fixes lint)
```

Run all three of `bun test`, `bun run typecheck`, `bun run lint` before committing. `bun test`
alone is not enough — the test runner strips types, so type errors pass tests silently.

## Non-negotiable invariants

These are the design. Violating one silently breaks a product guarantee, so they are worth
re-reading before changing anything in `packages/domain`.

1. **Evidence edges are factual, never causal.** `DEPLOYED_TO`, `INTRODUCED_BY`, `EMITTED_BY`,
   `PART_OF`, `PRECEDED`, `SIMILAR_TO`. There is no `CAUSED_BY`, and a test asserts its absence.
   Causal claims live only in `Hypothesis`, which cites evidence by id. A causal edge would let
   the reasoner write its conclusions back into the evidence it reasons over.
2. **Evidence is immutable and append-only.** Re-collection writes new nodes, deduplicated on
   `dedupeKey`. Mutating evidence rots citations — "here is the evidence for that conclusion"
   quietly becomes a lie.
3. **Every AI claim cites evidence.** `serializeForReasoning` labels each node (`E1`, `E7`);
   `validateCitations` rejects output referencing a label that was not shown. This check, not
   prompt wording, is what stops the model guessing.
4. **Missing information is computed, not generated.** It comes from `collector_runs` via
   `missingInformationFrom()`. A model cannot introspect what it was never shown; asking it to
   produces a plausible, wrong list.
5. **Collectors return structured JSON, never raw text.** Schemas forbid unbounded payloads by
   *shape*: `log_pattern` has no field for raw lines at all, `metric_series` caps datapoints.
6. **One handler across channels.** Rendering may branch on `message.channel`; investigation logic
   never does. Duplicating a handler per platform also disqualifies the submission.
7. **No unsolicited outbound.** `initiate()` only to an operator-configured allowlist, only in
   response to a real alert, once per incident.
8. **TDD.** Write the failing test, watch it fail for the right reason, then implement.

## Architecture

```
packages/domain/     ← built. Zod only, zero I/O. The shared language.
packages/collectors/ ← Collector interface, seeded fixture source, real GitHub collector
packages/reasoner/   ← Reasoner interface; Gemini 2.5 Flash + RecordedReasoner
packages/db/         ← in-memory + Postgres implementations of domain ports
apps/agent/          ← Caspian: single onMessage handler, channel-aware rendering
```

Dependencies point inwards. `packages/domain` defines repository *interfaces* (`src/ports.ts`);
storage conforms to them. That is what lets the whole suite run in-memory in milliseconds and
`bun run dev` work with no database.

### The pipeline

```
alert → Investigation (mirrors an external incident)
      → collectors run in parallel → EvidenceNode[] + EvidenceEdge[]
      → buildEvidenceGraph (validate, dedupe, order)
      → serializeForReasoning → labelled prompt text + idMap
      → Reasoner → Hypothesis[] (citations validated against idMap)
      → channel-aware render → Caspian reply
```

### Key design decisions

**Trace mirrors incidents, it does not own them.** PagerDuty/Datadog own lifecycle; `Investigation`
holds an `externalRef` back to them. `findByExternalRef` is the ingestion idempotency key — a
webhook delivered three times must produce one investigation.

**`ready` and `failed` are terminal.** Re-investigating creates a *new* `Investigation`, because
evidence is immutable and existing citations must keep resolving.

**Ordering is by `occurredAt`, never `collectedAt`.** Collection lag varies wildly between sources;
ordering by fetch time would routinely show a deploy *after* the errors it caused. Nodes carry
three clocks: `occurredAt`, `observedAt`, `collectedAt`.

**Determinism is a hard requirement of `serialize.ts`.** The same graph must produce byte-identical
text, or "why did it say that?" is unanswerable later and prompt caching cannot work. Everything —
graph ordering, section grouping, relation sorting — exists to hold that property.

**A partial investigation is a success.** One failing collector must never fail an investigation;
the gap is recorded and reported. A partial reconstruction with honest blind spots beats an error
at 3am.

**`config_change` carries a `redacted` flag.** Config diffs routinely contain credentials, and a
summary is prompt text bound for a third-party LLM. When set, `summarize()` omits the values.

### Evidence kinds are a plugin registry

Core kinds ship in-tree with **bare** names (`deployment`); plugin kinds **must** be dot-namespaced
(`vendor.acme.thing`) so they cannot squat on a name later promoted to core. Nodes store
`kind@version`, and old definitions stay registered so historical investigations remain readable —
stored payloads are never rewritten.

Every kind is self-describing: `schema`, `examples`, `identity`, `summarize`, `timestamps`,
optional `sourceUrl`. Core and plugin kinds render through the same `summarize()` path, so a
third-party collector is legible to the reasoner on day one.

Any new kind must pass `assertValidEvidenceKind` from `@trace/domain/testing`, which checks naming,
schema strength (rejects `z.any()`), identity/summarize determinism, bounded summaries and valid
dates. Add it to `CORE_KINDS` and it is exercised automatically.

## Conventions

- Strict TypeScript including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Biome
  bans `any` and non-null assertions. The registry's `AnyEvidenceKindDefinition` is the one
  sanctioned `any`, with a `biome-ignore` explaining why.
- Time is injected (`now: Date` parameters, the `Clock` port), never read from the system clock in
  domain code.
- Domain constructors take a single input object, return a new value, and never mutate.
- `TenantContext` is passed explicitly to every repository method. There is no ambient tenant — a
  misplaced `orgId` is a data breach, not a bug.
- Comments explain *why*, particularly where a choice looks arbitrary. Match that density.
- Evidence kinds live in `kinds/` grouped by family (`change.ts`, `signal.ts`, `context.ts`), not
  one file per kind.

## Verification beyond tests

**A green suite is evidence that the tests pass, not that the code works.** No piece of work is done
until it has been validated by *running* it, and until every claim made about it has been checked
against observed output rather than assumed.

For anything a human or an LLM reads, render it and read it. A serializer bug that produced
`Elevated 5xx rate on payments-api on payments-api` passed the entire suite; it was found by
printing a sample graph. So was relation ordering that listed `E11` above `E2`.

Then probe the invariants directly — a throwaway script against real fixture data, not the
two-node synthetic graphs the unit tests use. Delete the script afterwards; whatever it finds
becomes a test that fails first. Phase 2 shipped green and had three further defects: edges were
not deduplicated though nodes were, so one fact read to the model as two independent observations;
a commit with no author block threw out of a date parse and cost the whole GitHub collector every
deploy it had already found; and the seeded and live GitHub collectors collided on one name, so
the report said "github was not consulted" beside three nodes of GitHub evidence.

That last one is the general lesson. **A test written from the same assumption as the code cannot
catch that assumption being wrong** — the smoke test asserted the contradiction as correct. Ask
what would have to be true for the output to be wrong *despite* the suite passing, then go check
that thing by running it.

Before reporting any work complete:

- `bun test`, `bun run typecheck`, `bun run lint` — all three, and read the output.
- Render every human- or model-facing surface the change touches, and read it end to end.
- Exercise the failure paths: a source that throws, hangs, is unconfigured, returns nothing.
- Compose the pieces the way the *next* phase will wire them, not the way the test does.
- Report findings as observed output. "Verified" without a command and its result is an assumption,
  and saying it is done when it is merely green is the one failure that costs a reviewer's trust.

## Constraints

- **No Anthropic or OpenAI key is available.** The reasoner targets Gemini 2.5 Flash on the Google
  AI Studio free tier, behind a thin `Reasoner` interface. Do not propose Claude or OpenAI at
  runtime.
- **The demo must run with zero credentials.** Seeded fixture incidents plus a `RecordedReasoner`
  replaying a captured response. Real connectors activate only when their env vars are present.
  Never make the default path require an API key.
- Free LLM tiers train on submitted prompts, so production Trace must not point one at real
  incident telemetry. Say so in the README.
