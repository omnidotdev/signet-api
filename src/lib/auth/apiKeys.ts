/**
 * Managed API keys: owners issue named keys for programmatic access (creating
 * and sending documents, bulk send, status and downloads from their own
 * servers). A key is `sgk_` plus 32 random bytes; only its SHA-256 hash is
 * stored, so a database leak does not leak usable keys, and the full secret is
 * returned exactly once at creation. A key acts as its owner in the workspace
 * that was active when it was issued, until revoked.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { apiKey } from "../db/schema.ts";
import type { Session } from "./session.ts";

export const API_KEY_PREFIX = "sgk_";
/** active keys one owner may hold, to bound sprawl and abuse */
export const MAX_KEYS_PER_OWNER = 25;
/** characters of the secret kept in clear (prefix included) to recognize a key */
const DISPLAY_PREFIX_LENGTH = 12;
/** how stale last-used may get before a request refreshes it (limits writes) */
const LAST_USED_RESOLUTION_MS = 60_000;

const hashKey = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");

export interface ApiKeyOwner {
  sub: string;
  email?: string;
  organizationId?: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type CreateApiKeyResult =
  | { ok: true; key: ApiKeySummary & { secret: string } }
  | { ok: false; error: "name_required" | "too_many_keys" };

/** Issue a new key for an owner; the returned secret is never retrievable again */
export const createApiKey = async (
  db: Db,
  owner: ApiKeyOwner,
  name: string,
): Promise<CreateApiKeyResult> => {
  const label = name.trim().slice(0, 80);
  if (!label) return { ok: false, error: "name_required" };
  const active = await db
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(and(eq(apiKey.ownerId, owner.sub), isNull(apiKey.revokedAt)));
  if (active.length >= MAX_KEYS_PER_OWNER)
    return { ok: false, error: "too_many_keys" };

  const secret = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const prefix = secret.slice(0, DISPLAY_PREFIX_LENGTH);
  const [row] = await db
    .insert(apiKey)
    .values({
      ownerId: owner.sub,
      ownerEmail: owner.email || null,
      organizationId: owner.organizationId ?? null,
      name: label,
      prefix,
      keyHash: hashKey(secret),
    })
    .returning();
  if (!row) throw new Error("failed to create api key");
  return {
    ok: true,
    key: {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: null,
      secret,
    },
  };
};

/** An owner's active keys, newest first, without any secret material */
export const listApiKeys = async (
  db: Db,
  ownerId: string,
): Promise<ApiKeySummary[]> => {
  const rows = await db
    .select()
    .from(apiKey)
    .where(and(eq(apiKey.ownerId, ownerId), isNull(apiKey.revokedAt)))
    .orderBy(desc(apiKey.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  }));
};

/** Revoke one of an owner's keys; false when it is not theirs or already revoked */
export const revokeApiKey = async (
  db: Db,
  ownerId: string,
  id: string,
): Promise<boolean> => {
  const revoked = await db
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKey.id, id),
        eq(apiKey.ownerId, ownerId),
        isNull(apiKey.revokedAt),
      ),
    )
    .returning({ id: apiKey.id });
  return revoked.length > 0;
};

/**
 * Authenticate a presented key: the session of its owner when the key exists
 * and is not revoked, else null. Records last use, at most once a minute.
 */
export const resolveApiKey = async (
  db: Db,
  secret: string,
): Promise<Session | null> => {
  if (!secret.startsWith(API_KEY_PREFIX)) return null;
  const [row] = await db
    .select()
    .from(apiKey)
    .where(and(eq(apiKey.keyHash, hashKey(secret)), isNull(apiKey.revokedAt)));
  if (!row) return null;

  const now = new Date();
  await db
    .update(apiKey)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(apiKey.id, row.id),
        or(
          isNull(apiKey.lastUsedAt),
          lt(
            apiKey.lastUsedAt,
            new Date(now.getTime() - LAST_USED_RESOLUTION_MS),
          ),
        ),
      ),
    );

  const organizationId = row.organizationId ?? undefined;
  return {
    sub: row.ownerId,
    email: row.ownerEmail ?? "",
    organizationId,
    workspaces: organizationId ? [{ id: organizationId }] : undefined,
    apiKeyId: row.id,
  };
};

/**
 * A fixed-window request limiter keyed by API key, so one key cannot flood the
 * service. In memory, which is sufficient for a single API replica; the budget
 * resets when the window rolls over.
 */
export const createRateLimiter = ({
  limit,
  windowMs,
  now = Date.now,
}: {
  limit: number;
  windowMs: number;
  now?: () => number;
}) => {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    /** spend one request from the key's budget; false when it is exhausted */
    take(key: string): boolean {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.start > windowMs) {
        windows.set(key, { start: t, count: 1 });
        return true;
      }
      if (w.count >= limit) return false;
      w.count += 1;
      return true;
    },
  };
};
