# Trace, containerised.
#
# Pinned to the exact Bun the repo is developed and tested against rather than a floating `1.3`,
# because there is no build step to catch a runtime difference: Bun executes the TypeScript
# directly, so the runtime *is* the compiler.
FROM oven/bun:1.3.13-alpine

WORKDIR /app

# Manifests first, so a source-only change does not re-resolve the dependency tree. The workspace
# package.json files are part of the resolution graph — `bun install` needs them to link
# @trace/domain and friends — so they are copied here too.
COPY package.json bun.lock ./
COPY apps/agent/package.json ./apps/agent/
COPY packages/domain/package.json ./packages/domain/
COPY packages/collectors/package.json ./packages/collectors/
COPY packages/reasoner/package.json ./packages/reasoner/
COPY packages/db/package.json ./packages/db/

# --frozen-lockfile: a deploy that silently resolves a different dependency tree than CI tested is
# how a green pipeline ships a broken container.
RUN bun install --frozen-lockfile

COPY . .

# No build stage. `bun start` runs apps/agent/src/main.ts as-is, which is also why CI runs `tsc`
# separately — the test runner strips types and would never see a type error.
#
# CMD, not ENTRYPOINT, so `docker run … bun run dev` still gets you the credential-free REPL.
CMD ["bun", "start"]
