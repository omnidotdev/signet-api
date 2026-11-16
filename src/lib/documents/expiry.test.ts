import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { document, signatureEvent } from "../db/schema.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createMultiSignerRequest,
  getSignerFillData,
  sendColumns,
  signByToken,
} from "./documentService.ts";
import { expireDue, takeExpiringSoon } from "./expiry.ts";

const DAY = 24 * 60 * 60 * 1000;

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const pdf = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const request = async (expiresInDays?: number) =>
  createMultiSignerRequest(db, {
    name: "Lease",
    pdf: await pdf(),
    signers: [
      { name: "Ada", email: "ada@example.com" },
      { name: "Grace", email: "grace@example.com" },
    ],
    ownerId: "owner-1",
    ownerEmail: "owner@example.com",
    senderName: "Olive Owner",
    message: "  Please sign by Friday  ",
    expiresInDays,
  });

describe("send options", () => {
  test("a request expires after the default unless the sender chooses", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(sendColumns(now).expiresAt?.getTime()).toBe(
      now.getTime() + 120 * DAY,
    );
    expect(sendColumns(now, { expiresInDays: 7 }).expiresAt?.getTime()).toBe(
      now.getTime() + 7 * DAY,
    );
    expect(sendColumns(now, { expiresInDays: 0 }).expiresAt).toBeNull();
    expect(sendColumns(now, { expiresInDays: 5000 }).expiresAt?.getTime()).toBe(
      now.getTime() + 365 * DAY,
    );
  });

  test("the sender's name and note are saved with the request", async () => {
    const req = await request();
    const [doc] = await db
      .select()
      .from(document)
      .where(eq(document.id, req.id));
    expect(doc?.ownerName).toBe("Olive Owner");
    expect(doc?.message).toBe("Please sign by Friday");
    expect(doc?.expiresAt).not.toBeNull();
  });
});

describe("request expiry", () => {
  test("signers are warned once shortly before it expires", async () => {
    const req = await request(2);
    const now = new Date();

    const soon = await takeExpiringSoon(db, now);
    expect(soon).toHaveLength(1);
    expect(soon[0]?.recipients.map((r) => r.email).sort()).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
    expect(soon[0]?.recipients.every((r) => r.signToken.length > 0)).toBe(true);
    expect(await takeExpiringSoon(db, now)).toEqual([]);
    expect(req.id).toBe(soon[0]?.documentId ?? "");
  });

  test("an expired request stops accepting signatures and says who to tell", async () => {
    const req = await request(1);
    const [ada, grace] = req.signers;
    await signByToken(db, serviceSigner, ada?.signToken as string, "Ada", {
      consent: true,
    });

    // past expiry but before the sweep: signing is already refused
    const later = new Date(Date.now() + 2 * DAY);
    await db
      .update(document)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(document.id, req.id));
    const refused = await signByToken(
      db,
      serviceSigner,
      grace?.signToken as string,
      "Grace",
      { consent: true },
    );
    expect(refused).toMatchObject({ ok: false, error: "expired" });

    const expired = await expireDue(db, later);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      documentName: "Lease",
      ownerEmail: "owner@example.com",
      signed: ["Ada"],
      unsigned: ["Grace"],
    });
    expect(expired[0]?.recipients.map((r) => r.email)).toEqual([
      "grace@example.com",
    ]);

    const [doc] = await db
      .select()
      .from(document)
      .where(eq(document.id, req.id));
    expect(doc?.status).toBe("expired");
    const events = await db
      .select({ type: signatureEvent.type })
      .from(signatureEvent)
      .where(eq(signatureEvent.documentId, req.id));
    expect(events.map((e) => e.type)).toContain("document.expired");

    const fill = await getSignerFillData(db, grace?.signToken as string);
    expect(fill?.closed).toBe("expired");
    // runs once
    expect(await expireDue(db, later)).toEqual([]);
  });

  test("a request with no expiry never expires", async () => {
    await request(0);
    expect(await expireDue(db, new Date(Date.now() + 1000 * DAY))).toEqual([]);
  });
});
