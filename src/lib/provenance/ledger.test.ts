import { describe, expect, test } from "bun:test";
import { type ProvenanceEvent, appendEvent, verifyLedger } from "./ledger.ts";

const buildChain = (): ProvenanceEvent[] => {
  let chain: ProvenanceEvent[] = [];
  chain = appendEvent(chain, {
    type: "document.created",
    data: { contentHash: "abc123", title: "Agreement" },
    timestamp: "2026-11-08T00:00:00.000Z",
  });
  chain = appendEvent(chain, {
    type: "document.signed",
    data: { signer: "grace@omni.dev", contentHash: "abc123" },
    timestamp: "2026-11-08T00:05:00.000Z",
  });
  return chain;
};

describe("provenance ledger", () => {
  test("links each event to its predecessor", () => {
    const chain = buildChain();

    expect(chain).toHaveLength(2);
    expect(chain[0].index).toBe(0);
    expect(chain[1].prevHash).toBe(chain[0].hash);
    expect(chain[0].hash).not.toBe(chain[1].hash);
  });

  test("verifies an untampered chain", () => {
    const result = verifyLedger(buildChain());

    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  test("detects tampering with an earlier event", () => {
    const chain = buildChain();
    // mutate the signed-content data without recomputing downstream hashes
    const tampered = structuredClone(chain);
    tampered[1].data.signer = "attacker@evil.test";

    const result = verifyLedger(tampered);

    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  test("detects a broken chain link", () => {
    const chain = buildChain();
    const tampered = structuredClone(chain);
    tampered[1].prevHash = "f".repeat(64);

    const result = verifyLedger(tampered);

    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });
});
