import type { Block } from 'caspian-sdk';

/**
 * The seam every transport meets the agent at.
 *
 * Caspian delivers a rich `Message`; the terminal REPL delivers a line of text. Both are narrowed
 * to this, so `handleMessage` is a pure function of an inbound message and its dependencies. That
 * is what makes "one handler across every channel" a property the tests can actually check rather
 * than a claim in a README — the REPL and the real gateway run the same function.
 */
export interface InboundMessage {
  /** Nullable upstream: a photo, sticker or voice note arrives with no text at all. */
  readonly text: string | null;
  /** `telegram`, `slack`, … Rendering may branch on this. Investigation logic never does. */
  readonly channel: string;
  /** Stable per thread. The key the agent's memory of an investigation hangs on. */
  readonly conversationId: string;
  readonly sender?: Record<string, unknown> | null;
}

/**
 * A reply, in both renderings.
 *
 * `text` is written to survive the least capable channel; `blocks` are Caspian's provider-neutral
 * rich format, rendered natively where supported and degraded where not. Sending both means one
 * renderer serves every channel.
 */
export interface Reply {
  readonly text: string;
  readonly blocks?: Block[];
}
