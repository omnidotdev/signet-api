import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import {
  apiKey,
  document,
  field,
  signatureEvent,
  signer,
  template,
} from "../db/schema.ts";
import { createSigningRequest } from "../documents/documentService.ts";
import { createSampleDocument } from "../signing/sampleDocument.ts";
import type { PdfBackend } from "../storage/pdfStore.ts";
import { setPdfBackend } from "../storage/pdfStore.ts";
import { createIdpWebhookRoutes } from "./webhooks.ts";

const SECRET = "test-idp-secret";
const ORG = "org-deleted";
const OTHER_ORG = "org-kept";

const sign = (body: string) =>
  createHmac("sha256", SECRET).update(body).digest("hex");

let db: Db;
let pdf: Uint8Array;
let objects: Map<string, Uint8Array>;

const memoryBackend = (): PdfBackend => ({
  put: async (key, bytes) => {
    objects.set(key, bytes);
  },
  get: async (key) => objects.get(key) ?? null,
  delete: async (key) => {
    objects.delete(key);
  },
});

// One migrated database for the file (migrating is slow); each test starts
// from empty tables
beforeAll(async () => {
  db = await createTestDb();
  pdf = await createSampleDocument({ title: "NDA" });
});

beforeEach(async () => {
  await db.delete(signatureEvent);
  await db.delete(field);
  await db.delete(signer);
  await db.delete(document);
  await db.delete(apiKey);
  await db.delete(template);
  objects = new Map();
  notified = [];
  setPdfBackend(memoryBackend());
});

afterEach(() => {
  setPdfBackend(null);
});

let notified: { documentName: string; emails: string[] }[] = [];

const app = (secret: string | undefined = SECRET) =>
  createIdpWebhookRoutes({
    getDb: () => db,
    webhookSecret: secret,
    notifyCanceled: (canceled) => {
      for (const pending of canceled)
        notified.push({
          documentName: pending.documentName,
          emails: pending.recipients.map((r) => r.email),
        });
    },
  });

const post = (
  body: unknown,
  { signature, secret }: { signature?: string | null; secret?: string } = {},
) => {
  const raw = JSON.stringify(body);
  return app(secret).handle(
    new Request("http://localhost/webhooks/idp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature === null
          ? {}
          : { "x-idp-signature": signature ?? sign(raw) }),
      },
      body: raw,
    }),
  );
};

// The flat shape Vortex delivers (IDP_EVENT_TRANSFORM)
const deleted = (organizationId: string) => ({
  eventType: "organization.deleted",
  organizationId,
  timestamp: new Date().toISOString(),
});

const seed = async (organizationId: string | undefined, ownerId: string) => {
  const req = await createSigningRequest(db, {
    name: `Contract ${organizationId ?? "personal"}`,
    pdf,
    signerName: "Ada Lovelace",
    signerEmail: "ada@example.com",
    ownerId,
    ownerEmail: "owner@example.com",
    organizationId,
  });
  await db.insert(apiKey).values({
    ownerId,
    organizationId: organizationId ?? null,
    name: "CI",
    prefix: "sgk_test",
    keyHash: `hash-${organizationId ?? "personal"}-${ownerId}`,
  });
  return req.id;
};

const rowsFor = async (documentId: string) => ({
  documents: (
    await db.select().from(document).where(eq(document.id, documentId))
  ).length,
  signers: (
    await db.select().from(signer).where(eq(signer.documentId, documentId))
  ).length,
  events: (
    await db
      .select()
      .from(signatureEvent)
      .where(eq(signatureEvent.documentId, documentId))
  ).length,
  fields: (
    await db.select().from(field).where(eq(field.documentId, documentId))
  ).length,
});

describe("POST /webhooks/idp organization.deleted", () => {
  test("deletes the workspace's documents with their signers, audit trail, PDFs, and API keys", async () => {
    const id = await seed(ORG, "user-a");
    expect((await rowsFor(id)).documents).toBe(1);
    expect((await rowsFor(id)).signers).toBe(1);
    expect(objects.has(`documents/${id}/original.pdf`)).toBe(true);

    const res = await post(deleted(ORG));
    expect(res.status).toBe(200);

    expect(await rowsFor(id)).toEqual({
      documents: 0,
      signers: 0,
      events: 0,
      fields: 0,
    });
    expect(objects.has(`documents/${id}/original.pdf`)).toBe(false);
    expect(
      await db.select().from(apiKey).where(eq(apiKey.organizationId, ORG)),
    ).toHaveLength(0);
    // The signer still holding a live link is told the request was canceled
    expect(notified).toEqual([
      { documentName: `Contract ${ORG}`, emails: ["ada@example.com"] },
    ]);
  });

  test("leaves another workspace's and a personal document, and account-scoped templates, untouched", async () => {
    await seed(ORG, "user-a");
    const other = await seed(OTHER_ORG, "user-a");
    const personal = await seed(undefined, "user-a");
    await db.insert(template).values({
      name: "NDA",
      ownerId: "user-a",
      pdfBase64: "",
      fields: [],
    });

    await post(deleted(ORG));

    expect((await rowsFor(other)).documents).toBe(1);
    expect((await rowsFor(personal)).documents).toBe(1);
    expect(objects.has(`documents/${other}/original.pdf`)).toBe(true);
    expect(await db.select().from(apiKey)).toHaveLength(2);
    expect(await db.select().from(template)).toHaveLength(1);
  });

  test("is idempotent: a redelivery acks 200 and notifies no one twice", async () => {
    await seed(ORG, "user-a");
    expect((await post(deleted(ORG))).status).toBe(200);
    expect((await post(deleted(ORG))).status).toBe(200);
    expect(notified).toHaveLength(1);
  });

  test("keeps every row when a stored PDF cannot be deleted, so the retry finds it", async () => {
    const id = await seed(ORG, "user-a");
    setPdfBackend({
      ...memoryBackend(),
      delete: async () => {
        throw new Error("storage unavailable");
      },
    });

    expect((await post(deleted(ORG))).status).toBe(500);
    expect((await rowsFor(id)).documents).toBe(1);
  });

  test("refuses an unsigned or forged call (401) and deletes nothing", async () => {
    const id = await seed(ORG, "user-a");
    expect((await post(deleted(ORG), { signature: null })).status).toBe(401);
    expect((await post(deleted(ORG), { signature: "deadbeef" })).status).toBe(
      401,
    );
    expect((await rowsFor(id)).documents).toBe(1);
  });

  test("fails closed (503) when no secret is configured", async () => {
    const id = await seed(ORG, "user-a");
    expect((await post(deleted(ORG), { secret: "" })).status).toBe(503);
    expect((await rowsFor(id)).documents).toBe(1);
  });

  test("rejects an event without an organization id (400)", async () => {
    expect((await post({ eventType: "organization.deleted" })).status).toBe(
      400,
    );
  });

  test("acks other identity events without effect", async () => {
    const id = await seed(ORG, "user-a");
    const res = await post({
      eventType: "member.removed",
      organizationId: ORG,
    });
    expect(res.status).toBe(200);
    expect((await rowsFor(id)).documents).toBe(1);
  });
});
