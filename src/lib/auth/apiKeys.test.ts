import { beforeEach, describe, expect, test } from "bun:test";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { apiKey } from "../db/schema.ts";
import {
  API_KEY_PREFIX,
  createApiKey,
  createRateLimiter,
  listApiKeys,
  MAX_KEYS_PER_OWNER,
  resolveApiKey,
  revokeApiKey,
} from "./apiKeys.ts";

const owner = {
  sub: "owner-1",
  email: "owner@example.com",
  organizationId: "org-1",
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("managed API keys", () => {
  test("creating a key returns the secret once and stores only a hash", async () => {
    const created = await createApiKey(db, owner, "CI pipeline");
    if (!created.ok) throw new Error(created.error);
    expect(created.key.secret.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(created.key.secret.length).toBeGreaterThan(40);
    expect(created.key.name).toBe("CI pipeline");
    expect(created.key.secret.startsWith(created.key.prefix)).toBe(true);

    const [row] = await db.select().from(apiKey);
    expect(row?.keyHash).not.toContain(created.key.secret);
    expect(JSON.stringify(row)).not.toContain(created.key.secret);
  });

  test("a key resolves to its owner's identity and workspace", async () => {
    const created = await createApiKey(db, owner, "Server");
    if (!created.ok) throw new Error(created.error);
    const session = await resolveApiKey(db, created.key.secret);
    expect(session?.sub).toBe("owner-1");
    expect(session?.email).toBe("owner@example.com");
    expect(session?.organizationId).toBe("org-1");
    expect(session?.workspaces).toEqual([{ id: "org-1" }]);
    expect(session?.apiKeyId).toBe(created.key.id);
  });

  test("an unknown or malformed key resolves to nothing", async () => {
    expect(
      await resolveApiKey(db, `${API_KEY_PREFIX}not-a-real-key`),
    ).toBeNull();
    expect(await resolveApiKey(db, "")).toBeNull();
    expect(await resolveApiKey(db, "Bearer something")).toBeNull();
  });

  test("listing shows the owner's active keys without secrets", async () => {
    const a = await createApiKey(db, owner, "A");
    await createApiKey(db, { ...owner, sub: "owner-2" }, "Other owner");
    const keys = await listApiKeys(db, "owner-1");
    expect(keys.map((k) => k.name)).toEqual(["A"]);
    expect(JSON.stringify(keys)).not.toContain(
      a.ok ? a.key.secret : "unreachable",
    );
    expect(keys[0]?.lastUsedAt).toBeNull();
  });

  test("using a key records when it was last used", async () => {
    const created = await createApiKey(db, owner, "Used");
    if (!created.ok) throw new Error(created.error);
    await resolveApiKey(db, created.key.secret);
    const [listed] = await listApiKeys(db, "owner-1");
    expect(listed?.lastUsedAt).toBeString();
  });

  test("a revoked key stops working, and only its owner can revoke it", async () => {
    const created = await createApiKey(db, owner, "Temp");
    if (!created.ok) throw new Error(created.error);
    expect(await revokeApiKey(db, "someone-else", created.key.id)).toBe(false);
    expect(await resolveApiKey(db, created.key.secret)).not.toBeNull();

    expect(await revokeApiKey(db, "owner-1", created.key.id)).toBe(true);
    expect(await resolveApiKey(db, created.key.secret)).toBeNull();
    expect(await listApiKeys(db, "owner-1")).toEqual([]);
  });

  test("an owner can hold a bounded number of active keys", async () => {
    for (let i = 0; i < MAX_KEYS_PER_OWNER; i++) {
      const r = await createApiKey(db, owner, `k${i}`);
      expect(r.ok).toBe(true);
    }
    expect(await createApiKey(db, owner, "one too many")).toEqual({
      ok: false,
      error: "too_many_keys",
    });
  });

  test("a key needs a name", async () => {
    expect(await createApiKey(db, owner, "   ")).toEqual({
      ok: false,
      error: "name_required",
    });
  });
});

describe("per-key rate limit", () => {
  test("allows up to the limit per window, then refuses until it resets", () => {
    let now = 0;
    const limiter = createRateLimiter({
      limit: 3,
      windowMs: 1000,
      now: () => now,
    });
    expect([1, 2, 3].map(() => limiter.take("k1"))).toEqual([true, true, true]);
    expect(limiter.take("k1")).toBe(false);
    // other keys have their own budget
    expect(limiter.take("k2")).toBe(true);
    now = 1001;
    expect(limiter.take("k1")).toBe(true);
  });
});
