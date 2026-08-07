# Trace

**An AI incident investigator that reconstructs what happened — and cites its evidence for every
claim.** It runs on [Caspian](https://trycaspianai.com), so you reach it on Telegram or Slack
through one identity and one handler.

Trace does **not** fix incidents. It answers the questions you spend the first hour of one asking:
*what changed, who deployed, what broke first, has this happened before.*

```
> investigate INC-481

INC-481 — what I found

An elevated 5xx rate was observed on payments-api [E1, E9], along with a decreased checkout
success rate on checkout-web [E2, E10], starting around 10:16. Payments-api logs show widespread
'redis: connection pool exhausted' errors [E11] … These issues followed a deployment of
payments-api v2.4.1 [E6] at 10:12, which included a configuration change reducing REDIS_POOL_MAX
from 50 to 5 [E4].

Most likely (95%): The incident was caused by the payments-api Redis connection pool being
exhausted due to the REDIS_POOL_MAX configuration being lowered from 50 to 5.
Evidence: E4, E6, E13, E14, E11, E8, E9, E12, E7
```

Every `[E4]` is a real piece of collected evidence. A claim citing something that was not collected
is rejected before you ever see it — not discouraged by the prompt, rejected by code.

---

## The problem

On-call engineers spend the first 30–60 minutes of an incident **reconstructing context** rather
than fixing anything: flipping between CloudWatch, Grafana, GitHub, PagerDuty and Slack to assemble
a timeline that, once assembled, usually makes the cause obvious. That reconstruction is
mechanical, it is the same every time, and it is the worst possible use of the one person who
could be fixing the problem.

It is also exactly the kind of work an LLM is untrustworthy at, for one reason: a plausible
incident narrative is very easy to generate and very hard to check at 3am. So the entire design of
Trace is built around making its claims checkable.

## Quickstart — no credentials, no Docker, no database

Requires [Bun](https://bun.sh) 1.3 or newer. Nothing else.

```bash
bun install
bun run dev
```

That is the whole setup. Then:

```
Trace — incident investigator. I reconstruct incidents; I do not fix them.
Reasoning: gemini-2.5-flash (replayed)
Storage:   in-memory
Try: investigate INC-481   then: why   ·   Ctrl-C to quit

> investigate INC-481
```

...which returns the report above, plus:

```
Timeline:
  09:41:00  [E13] Commit 9f2c1ab by dmitri: Reduce redis pool max from 50 to 5
  09:58:00  [E14] PR acme/payments-api#1893 "Tune Redis connection pool for lower idle cost" by dmitri — 2 file(s), +12/-4
  10:00:00  [E8] redis.command.timeout_rate on payments-api: 0.2–12.9 errors/s (+5060%), baseline 0.25
  10:00:00  [E9] http.server.5xx_rate on payments-api: 0.1–10.4 errors/s (+8567%), baseline 0.12
  10:05:00  [E3] Flag new-cart-ui on checkout-web off → partial at 25% by priya
  10:10:00  [E10] checkout.success_rate on checkout-web: 63.8–99.1 % (-36%), baseline 99.2
  10:12:00  [E4] Config REDIS_POOL_MAX on payments-api changed by ci-bot via helm: 50 → 5
  10:12:00  [E5] Config REDIS_AUTH_TOKEN on payments-api changed by vault-sync via vault (values redacted)
  10:12:00  [E6] Deployed payments-api v2.4.1 (from v2.4.0) to production by ci-bot — succeeded
  10:13:00  [E11] 4127× [error] on payments-api: redis: connection pool exhausted (waited <duration>) (2026-08-06T10:13:00.000Z → 2026-08-06T10:19:00.000Z)
  10:16:00  [E1] [critical] Elevated 5xx rate on payments-api (via pagerduty)
  10:17:00  [E12] 812× [error] on checkout-web: upstream payments-api returned 503 after <duration> (2026-08-06T10:17:00.000Z → 2026-08-06T10:22:00.000Z)
  10:19:00  [E2] [high] Checkout success rate below SLO on checkout-web (via pagerduty)

No blind spots: every source reported.

Reasoned by gemini-2.5-flash (replayed)
```

Then ask `why`:

```
95% — The incident was caused by the payments-api Redis connection pool being exhausted…
  supported by: E4, E6, E13, E14, E11, E8, E9, E12, E7

20% — The change to REDIS_AUTH_TOKEN on payments-api contributed to the connection issues.
  supported by: E5
  argues against: E11

10% — The new-cart-ui feature flag change on checkout-web caused the incident.
  supported by: E3
  argues against: E11, E16
```

Note the third one. The seeded incident deliberately contains a **decoy** — an unrelated feature
flag change at 10:05, minutes before the alert — and the model ranks it at 10% with evidence
*arguing against* it. Evidence that contradicts a theory is the most useful thing in an incident
report and the easiest to lose, so it is rendered explicitly.

Other things to try: `show deploy`, `show config`, `help`.

> **Run from the repo root.** Bun loads `.env` from the working directory while module resolution
> follows the file, so `cd apps/agent && bun run src/main.ts` starts cleanly and silently ignores
> every credential you configured.

## Talk to it on a real channel

```bash
cp .env.example .env      # add CASPIAN_API_KEY (free, instant) + TELEGRAM_BOT_TOKEN
bun start
```

`CASPIAN_API_KEY` is the only credential `bun start` requires. Everything else degrades gracefully
— see the table below.

The bot is **[@trace_b_bot](https://t.me/trace_b_bot)** on Telegram — `investigate INC-481`, then
`why`, then ask it anything about the incident. Replies render natively as headings, fields, a
timeline list and deep-link buttons to the real deploy/PR/commit, with a `Why?` button that
continues the thread.

**It is deployed and live** — a Railway worker with reasoning against live Gemini 2.5 Flash, so the
report you get is generated for you rather than replayed. Just message the bot; there is nothing to
install.

There is no deploy URL, and that is by design rather than an omission: Caspian's `listen()` is an
*outbound* long poll, so Trace binds no port and serves no HTTP. The Telegram handle **is** the
address. (The one optional inbound surface, the alert webhook, is off unless an operator sets
`TRACE_ALERT_PORT`.)

### Deploying it

Packaged and ready: `Dockerfile`, `railway.toml` and `fly.toml` are committed, and the image was
verified by building and running it rather than by inspection. The image is host-agnostic — deploy
it anywhere, as long as it runs as a **worker**.

**Railway + Neon** (no payment method required to start):

```bash
npm i -g @railway/cli && railway login
railway init && railway up                  # builds the Dockerfile, runs it as a worker
railway variables --set CASPIAN_API_KEY=… --set TELEGRAM_BOT_TOKEN=… --set GEMINI_API_KEY=…
railway logs                                # expect: "[trace] telegram connected (active)"
```

For persistence, create a free Postgres on [Neon](https://neon.com) and set `DATABASE_URL`. Neon
supports pgvector on every plan, and migration `0002` runs `create extension if not exists vector`
itself, so there is no manual step:

```bash
railway variables --set DATABASE_URL='postgres://…@…neon.tech/trace?sslmode=require'
```

> **Verify your Railway account** (connect GitHub) before relying on it. Unverified trial accounts
> get **restricted outbound network access**, and Trace is *entirely* outbound — it long-polls the
> Caspian gateway and calls Gemini. A restricted account fails in a way that looks like a broken
> bot rather than a blocked network.

**Fly** works too, but now requires a card on file:

```bash
fly launch --no-deploy --copy-config --region iad
fly secrets set CASPIAN_API_KEY=… TELEGRAM_BOT_TOKEN=… GEMINI_API_KEY=…
fly deploy && fly status                    # the machine must read "started"
```

Or plain Docker, anywhere:

```bash
docker build -t trace . && docker run --env-file .env trace
```

> **The machine must never scale to zero.** Caspian's `listen()` is an *outbound* long poll — Trace
> dials the gateway, never the reverse — so the bot needs no inbound port and receives no HTTP
> traffic at all. Any host that stops a container on "no requests" will silently kill the bot, and
> it looks exactly like a handler bug. That is why `fly.toml` has no `[http_service]` block, and why
> on Railway or Render this must be deployed as a **worker**, not a web service.

Add `DATABASE_URL` as a secret to get persistence (`fly postgres` needs the pgvector extension;
migration `0002` fails loudly and names it if it is missing).

## What you're actually running

Trace ships in one mode and unlocks into others by configuration, never by code change. Nothing is
mocked: the credential-free path is the same agent, with a real recorded model response behind it.

| You set | Reasoning | "Seen this before?" | Evidence | Free-form Q&A |
|---|---|---|---|---|
| *nothing* | Replayed from a genuinely captured Gemini response | Deterministic lexical embedder | 7 seeded sources | Declined, and says why |
| `GEMINI_API_KEY` | **Live Gemini 2.5 Flash**, recording kept behind it as a 429 fallback | `gemini-embedding-001`, 768-d, HNSW/cosine | 7 seeded sources | **Live and grounded** |
| `+ GITHUB_TOKEN` & `TRACE_GITHUB_REPOS` | ” | ” | **Real** deploys, PRs and commits replace their seeded stand-in | ” |
| `+ DATABASE_URL` | ” | pgvector | ” | ” |

Trace always tells you which one you are looking at: the report footer names the model verbatim,
and reads `gemini-2.5-flash (replayed)` when it is a recording. A recording is never allowed to
pass for live reasoning.

## How Caspian fits

Caspian is the communication layer, not a transport Trace happens to call. The test of that is
what it would cost to add a channel: here it is one `connectX` line in `connectChannels` and
nothing else — no handler, no renderer, no branch.

```ts
const client = new CommClient({ apiKey });        // one identity, every channel

client.onMessage(async (message) => {
  const reply = await handleMessage(deps, {       // the single handler
    text: message.text,
    channel: message.channel,
    conversationId: message.conversationId,
    sender: message.sender,
  });
  // `html` is null on purpose: plain prose plus provider-neutral blocks, rendered per channel
  // by the gateway. Replying to the message is also what keeps the answer in its thread.
  await message.reply(reply.text, null, reply.blocks ?? null);
});

// A button tap carries the text a user could have typed, so it takes the identical path.
client.onInteraction(async (interaction) => {
  const reply = await handleMessage(deps, { ...interaction, text: interaction.value });
  await interaction.reply(reply.text, null, reply.blocks ?? null);
});

await client.listen({ ack: 'On it, one moment…' });
```

| Caspian surface | How Trace uses it |
|---|---|
| `onMessage` | **The** handler. `handleMessage(deps, message)` — one pure function, every channel. |
| `onInteraction` | A button tap carries `value`, which is text a user could have typed, so a tap and a message take the *identical* path. No second code path to keep in sync. |
| `listen({ ack })` | An outbound long poll. `ack` covers channels with no typing indicator — a reconstruction takes seconds, and silence reads as a broken bot. |
| `connectTelegram` / `installSlack` | The connect helpers, called once in `connectChannels`. Slack's install is branded and reuses `SLACK_CONNECTION_ID`. |
| `getConnection` | Checked at startup so a restart reuses the existing install instead of minting an orphan. |
| `channelGuide(channel)` | Channel **etiquette**, fetched from Caspian and memoised per channel — Slack's mrkdwn is not standard markdown, X caps a post at 300 characters. Caspian maintains those rules, so this repo cannot drift from them. |
| `initiate` | The only outbound-first path, to an operator allowlist, once per incident. |
| `login` | Surfaced as a typed `AccountRequiredError` telling the operator to run `caspian login`. |
| `Block[]` | Provider-neutral, so **one** renderer serves every channel: the gateway renders blocks natively on Slack, Discord and Telegram and degrades to clean text elsewhere. |
| Threading | Caspian keeps `conversationId` stable per thread, which is what makes a bare `why` three messages later resolve to the right investigation. |

Three consequences worth being explicit about, because they are the difference between using an SDK
and building on it:

- **One handler, provable.** `handleMessage` never reads `message.channel`. A test drives the same
  script through Telegram and Slack and asserts identical `text` *and* `blocks` — the challenge
  explicitly does not count one bot per platform, so this is a test rather than a claim.
- **Channel-aware where it earns its place.** Rendering and etiquette branch on channel;
  investigation logic never does. Asking Caspian how to behave on a channel is not the handler
  branching — the same code path runs either way, only the wording guidance differs.
- **Etiquette is fetched, not hardcoded.** `behaviorPrompt()` returns empty until an agent is
  configured while `channelGuide(channel)` has real content — found by calling both against the
  live gateway, which is why Trace fetches per channel.

## Design: why you can trust the output

Eight invariants hold the product together. These are not style preferences — each one is enforced
by code and covered by a test that fails if it is violated.

1. **Every AI claim cites evidence.** The graph is serialised with labels (`E1`, `E7`) and a
   hypothesis is *constructed* by resolving its citations against that map. A claim citing
   something the model was not shown is unrepresentable, not merely rejected.
2. **Evidence edges are factual, never causal.** `DEPLOYED_TO`, `INTRODUCED_BY`, `EMITTED_BY`,
   `PART_OF`, `PRECEDED`, `SIMILAR_TO`. There is no `CAUSED_BY`, and a test asserts its absence —
   a causal edge would let the reasoner write its conclusions back into the evidence it reasons
   over.
3. **Missing information is computed, not generated.** "What I could not see" comes from the
   collector run table, never from the model. A model cannot introspect what it was never shown;
   asked anyway, it produces a plausible, wrong list — and blind spots are the part of a report a
   reader has no way to check.
4. **Evidence is immutable and append-only.** Re-collection writes new nodes deduplicated on
   identity. Mutating evidence rots citations: "here is the evidence for that conclusion" quietly
   becomes a lie.
5. **Collectors return structured JSON, never raw text.** The schemas forbid unbounded payloads by
   *shape* — `log_pattern` has no field for raw lines at all, `metric_series` caps its datapoints.
6. **One handler across channels.** Telegram, Slack and the terminal REPL all call the same
   `handleMessage`. Rendering may branch on channel; investigation logic never does.
7. **No unsolicited outbound.** Trace speaks first only to an operator-configured allowlist, only
   in response to a real alert, once per incident. With the allowlist unset it pages nobody.
8. **A partial investigation is a success.** A failing collector — or a failing *reasoner* —
   produces a report with an honest gap, never an error. A partial reconstruction with stated blind
   spots beats a stack trace at 3am.

Two consequences worth calling out, because both were bugs first:

- **Ordering is by `occurredAt`, never `collectedAt`.** Collection lag varies wildly between
  sources; ordering by fetch time routinely shows a deploy *after* the errors it caused.
- **`config_change` carries a `redacted` flag.** Config diffs routinely contain credentials, and a
  summary is prompt text bound for a third-party LLM. `E5` in the transcript above is a real
  credential rotation, rendered as *"(values redacted)"*.

## Architecture

```
alert → Investigation (mirrors an external incident)
      → collectors run in parallel → EvidenceNode[] + EvidenceEdge[]
      → buildEvidenceGraph (validate, dedupe, total order)
      → serializeForReasoning → labelled prompt text + idMap
      → Reasoner → Hypothesis[] (citations validated against idMap)
      → channel-aware render → Caspian reply
```

```
packages/domain/      Zod only, zero I/O. Entities, the evidence-kind registry, the graph,
                      deterministic serialisation, the citation gate, repository interfaces.
packages/collectors/  Collector interface, parallel runner with per-collector timeouts,
                      seeded fixtures, a real GitHub collector.
packages/reasoner/    Reasoner port, Gemini 2.5 Flash client, RecordedReasoner, embeddings.
packages/db/          In-memory and Postgres implementations of the same ports.
apps/agent/           Caspian: one onMessage handler, channel-aware rendering, alert ingress.
```

Dependencies point inwards. `packages/domain` defines the repository *interfaces*, and storage
conforms to them — which is what lets the whole test suite run in-memory in milliseconds and
`bun run dev` work with no database at all.

**Determinism is a hard requirement of the serialiser.** The same graph must produce byte-identical
prompt text, or "why did it say that?" is unanswerable later and prompt caching cannot work.
Everything about graph ordering, section grouping and relation sorting exists to hold that
property.

**Evidence kinds are a plugin registry.** Core kinds ship in-tree with bare names (`deployment`);
plugin kinds must be dot-namespaced (`vendor.acme.thing`) so they cannot squat on a name later
promoted to core. Every kind is self-describing and must pass `assertValidEvidenceKind` from
`@trace/domain/testing`, which rejects `z.any()`, non-deterministic identity, and unbounded
summaries. A third-party collector is legible to the reasoner on day one.

## The Postgres path

Entirely optional — everything above works without it.

```bash
docker compose up -d
DATABASE_URL=postgres://trace:trace@localhost:5433/trace bun start
```

Migrations run on connect, so there is no second command to forget. You get durable investigations
(a restart returns the *stored* report rather than re-reasoning, so "why?" three days later
explains the conclusion you were actually shown) and pgvector-backed "has this happened before?".

Port 5433, not 5432, so it does not fight a Postgres already running on your machine.

## Proactive paging

The one path where Trace speaks first. Set `TRACE_ALERT_PORT` and `TRACE_ONCALL_RECIPIENTS`, then:

```bash
curl -X POST localhost:8787 -d '{"system":"pagerduty","id":"INC-481","summary":"Elevated 5xx rate"}'
```

Trace reconstructs the incident and pages the rotation **with the finding already in hand** — that
is the whole point of proactive outreach, arriving with the reconstruction rather than with a
notification. Once per incident, allowlist only, and silent unless both variables are set.

## Channel status — read this before evaluating

**Telegram is verified live** as [@trace_b_bot](https://t.me/trace_b_bot): `investigate`, `why`,
free-form questions, native block rendering, deep-link buttons, and Caspian auto-threading each
reply. Verified means *observed working over a real Telegram conversation*, not asserted — reading
that conversation is what caught the `/start` and ack defects, and timing it is what caught
follow-ups re-reasoning (40s → 1ms). It now runs as a deployed Railway worker rather than on a
laptop, reasoning against live Gemini — confirmed by reading the gateway's own message log, where
the deployed reply differs in wording from the recorded one, which is what proves it is generating
rather than replaying.

**Slack is implemented but has never delivered a message, and the block is upstream of this
repo.** Being specific, because a vague "partially working" would be worth less than the facts:

- Slack runs through the identical `handleMessage` — a test drives one script through both channels
  and asserts identical `text` *and* `blocks`.
- The Caspian connection reaches `active` (`slack:trace`, capabilities include `receive`, bound to
  the same agent as the working Telegram connection, `error: null`).
- Across four distinct triggers — a plain channel message, a real `@`-mention, removing the app,
  re-adding it — the gateway recorded **zero** events. Paged explicitly with `afterSeq`, the stream
  holds only `connection.authorized` / `connection.active`, which come from the OAuth *redirect*,
  not from Slack's Events API.
- Conclusion: Caspian's shared Slack app is not receiving Events API deliveries for this workspace.
  A second install is impossible while the first holds the identity, and the SDK exposes no
  `deleteConnection` to release it.

Consequently **not** claimed: Slack mrkdwn rendering of the blocks, the `Why?` button through
`onInteraction` on Slack, and whether the display-name branding took.

Hardening that path did find three real defects, all now fixed and tested: every start minted a
*new* connection (orphaning installs and invalidating the `authorize_url` you were about to click);
the startup log printed `connected` for a status that was not; and `connections[0]` was used as the
outbound alert connection, which would have paged nobody the moment a pending Slack sorted first.
Also worth knowing: the gateway's pre-approval status is `pending_oauth`, not `pending` — every
check is written `=== 'active'`, because the natural `!== 'pending'` reads an unapproved install as
connected.

## Production caveat

**Free LLM tiers train on submitted prompts.** Trace's evidence summaries are prompt text bound for
a third-party model, so a production deployment must not point a free tier at real incident
telemetry. The `Reasoner` interface exists partly for this: swapping in a self-hosted or
zero-retention model is one implementation, not a refactor. The `redacted` flag on `config_change`
reduces the blast radius but is not a substitute.

## Development

```bash
bun test                                       # whole suite (~200ms, no credentials)
bun run typecheck                              # tsc across all workspaces
bun run lint                                   # biome

# The repository contract suite against real Postgres — the same tests, run twice.
docker compose up -d
TRACE_TEST_DATABASE_URL=postgres://trace:trace@localhost:5433/trace bun test
```

Run all three before committing. `bun test` alone is not enough: the test runner strips types, so
type errors pass the tests in silence.

A green suite is evidence the tests pass, not that the code works. Every phase of this project was
signed off by *running* it — printing the actual rendered report, breaking credentials on purpose,
simulating a 429 storm — and that is what found the serialiser printing `on payments-api on
payments-api`, relation ordering listing `E11` above `E2`, edges deduplicated for nodes but not for
edges (one fact reading to the model as two independent observations), and the repository contract
going 13 red against real Postgres while staying green in memory.

## The four evaluation criteria

**Problem it solves.** One concrete job: reconstruct a production incident and answer follow-ups
about it. Not "AI for incidents" — the measurable 30–60 minutes an on-call engineer spends
assembling context before anyone starts fixing. Trace explicitly does *not* fix, page-and-hope, or
chat generally; it has one job and declines the rest, including free-form questions it cannot
ground.

**Code quality.** 463 tests running in ~180ms with no credentials, plus 499 against real Postgres in
CI. Strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; Biome bans
`any` and non-null assertions. Dependencies point inwards — `packages/domain` is Zod-only with zero
I/O and defines the repository *interfaces* that both storage backends implement, which is what lets
the whole suite run in-memory in milliseconds. One repository contract suite is written once and run
twice, in-memory and against Postgres; it went 13 red against real SQL while green in memory, which
is the entire argument for writing it that way. Failure paths are exercised rather than assumed: a
collector that throws, hangs, or is unconfigured; a 429 storm; an unreachable database.

**Adoption / usage.** `bun install && bun run dev` is the whole quickstart — no API key, no
database, no Docker — and it runs the real agent, not a mock. Every credential added upgrades a
capability rather than unlocking a blank screen, so there is no cliff between "trying it" and "using
it". **Deployed and publicly reachable** as [@trace_b_bot](https://t.me/trace_b_bot) — a Railway
worker reasoning against live Gemini, with `Dockerfile`, `railway.toml` and `fly.toml` committed so
anyone can stand up their own in one command. The live path is verified end to end against the
gateway's own message log, not asserted.

**How Caspian fits.** See [How Caspian fits](#how-caspian-fits). One `CommClient`, one
`handleMessage` that never branches on channel, `onInteraction` so a tap and a typed message are the
same path, provider-neutral `Block[]` so one renderer serves every channel, threading via a stable
`conversationId`, and channel etiquette fetched from `channelGuide()` rather than hardcoded. Adding
a channel is one `connectX` call and nothing else.

## Secrets

No secrets in git, and nothing hardcoded. Credentials enter only at the composition root
(`apps/agent/src/wiring.ts`) and the two entrypoints (`main.ts`, `repl.ts`); every "is this
configured?" decision lives there, so no other file asks what mode it is in. Library packages take
configuration as a parameter rather than reading the environment — the one function with a default
of `process.env` still accepts an explicit object, which is how the tests drive it.
`.env` is gitignored and has never been tracked; `.dockerignore` keeps it out of the image,
which was checked by looking inside the built image rather than by reading the file. Full history
has been scanned for key shapes (`AIza`, `ghp_`, `github_pat_`, `xoxb-`, `xapp-`, bot-token
patterns) with zero matches. Every variable is documented with the consequence of leaving it unset
in [`.env.example`](.env.example), and none is required for the quickstart.

Beyond git: `config_change` evidence carries a `redacted` flag so credential values never reach
prompt text bound for a third-party model, and the Gemini API key travels in a header rather than
the documented `?key=` query parameter, because a key in a URL reaches proxy logs.

## Explicitly out of scope

Listed rather than hidden: the remaining 8 collectors (only GitHub is real; the rest are seeded), an
action engine (Jira, rollback), CQRS, multi-provider LLM adapters, BullMQ orchestration,
multi-tenant row-level security, and OpenTelemetry.

## Licence

MIT.
