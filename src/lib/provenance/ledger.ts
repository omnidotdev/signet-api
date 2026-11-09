import { createHash } from "node:crypto";

/** A single recorded step in a document's provenance history */
export interface ProvenanceEvent {
  /** Zero-based position in the chain */
  index: number;
  /** ISO 8601 timestamp of when the event was recorded */
  timestamp: string;
  /** Event kind, for example "document.created" or "document.signed" */
  type: string;
  /** Event payload, for example signer identity or a content hash */
  data: Record<string, unknown>;
  /** Hash of the previous event, binding this event to the chain */
  prevHash: string;
  /** Hash of this event, computed over all other fields */
  hash: string;
}

const GENESIS_PREV_HASH = "0".repeat(64);

/** Produce a stable JSON encoding so hashing is deterministic */
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(
          (value as Record<string, unknown>)[key],
        )}`,
    );
  return `{${entries.join(",")}}`;
};

const hashEvent = (event: Omit<ProvenanceEvent, "hash">): string =>
  createHash("sha256")
    .update(
      `${event.index}|${event.timestamp}|${event.type}|${canonicalize(
        event.data,
      )}|${event.prevHash}`,
    )
    .digest("hex");

/**
 * Append an event to a provenance chain, returning the extended chain.
 *
 * Each appended event embeds the hash of its predecessor, so any later edit to
 * an earlier event invalidates every hash that follows it. This is the
 * tamper-evident core of Signet provenance
 */
export const appendEvent = (
  chain: ProvenanceEvent[],
  input: { type: string; data: Record<string, unknown>; timestamp?: string },
): ProvenanceEvent[] => {
  const prev = chain.at(-1);
  const partial: Omit<ProvenanceEvent, "hash"> = {
    index: chain.length,
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: input.type,
    data: input.data,
    prevHash: prev ? prev.hash : GENESIS_PREV_HASH,
  };
  return [...chain, { ...partial, hash: hashEvent(partial) }];
};

export interface LedgerVerification {
  valid: boolean;
  /** Index of the first event that failed verification, when invalid */
  brokenAt: number | undefined;
}

/**
 * Verify that a provenance chain is internally consistent and untampered.
 *
 * Every event's hash is recomputed and its link to the previous event is
 * checked. The first mismatch is reported
 */
export const verifyLedger = (chain: ProvenanceEvent[]): LedgerVerification => {
  let expectedPrev = GENESIS_PREV_HASH;

  for (const event of chain) {
    if (event.prevHash !== expectedPrev) {
      return { valid: false, brokenAt: event.index };
    }
    const recomputed = hashEvent({
      index: event.index,
      timestamp: event.timestamp,
      type: event.type,
      data: event.data,
      prevHash: event.prevHash,
    });
    if (recomputed !== event.hash) {
      return { valid: false, brokenAt: event.index };
    }
    expectedPrev = event.hash;
  }

  return { valid: true, brokenAt: undefined };
};
