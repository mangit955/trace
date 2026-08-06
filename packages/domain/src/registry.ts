import type { z } from 'zod';

/**
 * The evidence kind registry.
 *
 * Collectors are plug-ins, so the set of evidence shapes cannot be closed at compile time. But the
 * reasoner and the UI both need predictable structure, and the LLM must never see inconsistent
 * payloads. The registry resolves that tension: each kind is a self-describing definition carrying
 * its own schema, its own LLM serialization, and its own identity function.
 *
 * Core kinds ship in-tree and get deep reasoner support. Plugin kinds must be namespaced and
 * degrade gracefully — the reasoner falls back to `summarize()` for anything it does not know.
 */

/** Canonical timestamps extracted from a payload. See EvidenceNode for why there are two. */
export interface NodeTimes {
  /** When the real-world event happened. */
  occurredAt: Date;
  /** When the source system recorded it. Diverges from occurredAt under clock skew. */
  observedAt?: Date | undefined;
}

export interface EvidenceKindDefinition<T = unknown> {
  /** Bare for core kinds (`deployment`); dot-namespaced for plugins (`vendor.acme.thing`). */
  readonly kind: string;
  /** Bumped on breaking payload changes. Old versions stay registered so history stays readable. */
  readonly version: number;
  readonly schema: z.ZodType<T>;
  /** At least one representative payload. Powers the conformance suite and doubles as docs. */
  readonly examples: readonly T[];
  /** Stable dedup key within an investigation. Must not include volatile fields. */
  identity(payload: T): string;
  /** Bounded, deterministic prose for the reasoning prompt. */
  summarize(payload: T): string;
  timestamps(payload: T): NodeTimes;
  /** Deep link a human can click to verify the claim themselves. */
  sourceUrl?(payload: T): string | undefined;
}

/**
 * The registry is heterogeneous by nature — it holds definitions for many unrelated payload types
 * behind one lookup. `any` is the escape hatch that makes that storable; type safety is restored
 * at the boundary by `parse()`, which validates through the definition's own schema.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry, see above
export type AnyEvidenceKindDefinition = EvidenceKindDefinition<any>;

/**
 * Dot-separated segments, each starting with a lowercase letter.
 *
 * Deliberately strict: kind names end up in database rows, prompt text, and plugin namespaces, so
 * `Deployment` and `deployment` being distinct kinds would be a lasting source of confusion.
 */
const KIND_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function assertValidKindName(kind: string): void {
  if (!KIND_NAME.test(kind)) {
    throw new Error(
      `Invalid evidence kind name ${JSON.stringify(kind)}. ` +
        'Expected lowercase segments of [a-z0-9_] separated by single dots, e.g. ' +
        '"deployment" or "vendor.acme.thing".',
    );
  }
}

function assertValidVersion(kind: string, version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `Invalid version ${version} for evidence kind "${kind}". Expected an integer >= 1.`,
    );
  }
}

function isNamespaced(kind: string): boolean {
  return kind.includes('.');
}

function key(kind: string, version: number): string {
  return `${kind}@${version}`;
}

export class EvidenceKindRegistry {
  readonly #definitions = new Map<string, AnyEvidenceKindDefinition>();
  readonly #coreKinds = new Set<string>();

  /**
   * Registers a first-class kind that ships with Trace. Core kinds use bare names and the reasoner
   * understands them structurally.
   */
  registerCore<T>(definition: EvidenceKindDefinition<T>): void {
    if (isNamespaced(definition.kind)) {
      throw new Error(
        `Core evidence kind "${definition.kind}" must not be namespaced. ` +
          'Namespaced names are reserved for plugin kinds registered via register().',
      );
    }
    this.#add(definition);
    this.#coreKinds.add(definition.kind);
  }

  /**
   * Registers a plugin-supplied kind. Namespacing is mandatory so a plugin cannot squat on a name
   * Trace may later want to promote to a core kind.
   */
  register<T>(definition: EvidenceKindDefinition<T>): void {
    if (!isNamespaced(definition.kind)) {
      throw new Error(
        `Plugin evidence kind "${definition.kind}" must be namespaced, e.g. ` +
          `"vendor.${definition.kind}". Bare names are reserved for core kinds.`,
      );
    }
    this.#add(definition);
  }

  #add(definition: AnyEvidenceKindDefinition): void {
    assertValidKindName(definition.kind);
    assertValidVersion(definition.kind, definition.version);

    const id = key(definition.kind, definition.version);
    if (this.#definitions.has(id)) {
      throw new Error(`Evidence kind ${id} is already registered.`);
    }
    this.#definitions.set(id, definition);
  }

  get(kind: string, version: number): AnyEvidenceKindDefinition | undefined {
    return this.#definitions.get(key(kind, version));
  }

  /** Like {@link get}, but throws rather than returning undefined. */
  require(kind: string, version: number): AnyEvidenceKindDefinition {
    const definition = this.get(kind, version);
    if (!definition) {
      throw new Error(`Unknown evidence kind ${key(kind, version)}.`);
    }
    return definition;
  }

  /**
   * Validates an untrusted payload against its kind's schema.
   *
   * Collector output is untrusted input — it comes from third-party APIs and, in the case of log
   * and alert text, ultimately from attackers. Parsing here means a malformed or hostile payload
   * becomes a failed collector run rather than a corrupt evidence node. Unknown keys are stripped
   * rather than passed through to the prompt.
   */
  parse(kind: string, version: number, payload: unknown): unknown {
    return this.require(kind, version).schema.parse(payload);
  }

  /** Whether this kind was registered as a core kind. */
  isCore(kind: string): boolean {
    return this.#coreKinds.has(kind);
  }

  list(): readonly AnyEvidenceKindDefinition[] {
    return [...this.#definitions.values()];
  }
}
