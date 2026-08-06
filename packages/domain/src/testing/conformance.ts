import type { EvidenceKindDefinition } from '../registry.ts';

/**
 * Conformance suite for evidence kind definitions.
 *
 * Exported from `@trace/domain/testing` so plugin authors can run it against their own kinds
 * before shipping them. Every core kind is run through it in CI, which keeps the suite honest —
 * a contract nobody executes is just a comment.
 *
 * The checks encode invariants the rest of the system quietly depends on: the reasoning prompt
 * assumes summaries are bounded and deterministic, dedup assumes identity is stable, and the
 * timeline assumes timestamps are real dates.
 */

/**
 * Upper bound on a single evidence summary.
 *
 * Prompt budget is a shared resource. Without a cap, one chatty collector can crowd every other
 * piece of evidence out of the investigation — and it would do so silently.
 */
export const MAX_SUMMARY_CHARS = 2000;

const KIND_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function fail(kind: string, message: string): never {
  throw new Error(`Evidence kind "${kind}" failed conformance: ${message}`);
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function assertValidEvidenceKind<T>(definition: EvidenceKindDefinition<T>): void {
  const { kind, version, schema, examples } = definition;

  if (!KIND_NAME.test(kind)) {
    fail(kind, 'kind name must be lowercase dot-separated segments of [a-z0-9_].');
  }
  if (!Number.isInteger(version) || version < 1) {
    fail(kind, `version must be an integer >= 1, got ${version}.`);
  }

  if (examples.length === 0) {
    fail(kind, 'must declare at least one example payload.');
  }

  // A schema that accepts undefined accepts essentially anything, which would defeat validation
  // at the collector boundary — the one place hostile input is supposed to be stopped.
  if (schema.safeParse(undefined).success) {
    fail(kind, 'schema is too permissive: it accepts undefined. Avoid z.any() / z.unknown().');
  }

  for (const [index, example] of examples.entries()) {
    const where = `example[${index}]`;

    const parsed = schema.safeParse(example);
    if (!parsed.success) {
      fail(kind, `${where} does not satisfy its own schema: ${parsed.error.message}`);
    }
    const value = parsed.data;

    const identity = definition.identity(value);
    if (typeof identity !== 'string' || identity.length === 0) {
      fail(kind, `${where}: identity() must return a non-empty string.`);
    }
    if (definition.identity(value) !== identity) {
      fail(kind, `${where}: identity() must be deterministic; two calls disagreed.`);
    }

    const summary = definition.summarize(value);
    if (typeof summary !== 'string' || summary.length === 0) {
      fail(kind, `${where}: summarize() must return a non-empty string.`);
    }
    if (summary.length > MAX_SUMMARY_CHARS) {
      fail(
        kind,
        `${where}: summarize() exceeds ${MAX_SUMMARY_CHARS} chars (got ${summary.length}).`,
      );
    }
    if (definition.summarize(value) !== summary) {
      fail(kind, `${where}: summarize() must be deterministic; two calls disagreed.`);
    }

    const times = definition.timestamps(value);
    if (!isValidDate(times.occurredAt)) {
      fail(kind, `${where}: timestamps().occurredAt is not a valid Date.`);
    }
    if (times.observedAt !== undefined && !isValidDate(times.observedAt)) {
      fail(kind, `${where}: timestamps().observedAt is present but not a valid Date.`);
    }

    const url = definition.sourceUrl?.(value);
    if (url !== undefined && !URL.canParse(url)) {
      fail(kind, `${where}: sourceUrl() must return an absolute URL or undefined, got "${url}".`);
    }
  }
}
