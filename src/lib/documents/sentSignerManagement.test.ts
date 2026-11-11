import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { signer } from "../db/schema.ts";
import {
  addSignerToSentDocument,
  createDraft,
  removePendingSignerFromSent,
  sendDraft,
} from "./documentService.ts";

const OWNER = "owner-1";

const tinyPdf = async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

const sentDoc = async (db: Db, names: string[]) => {
  const draft = await createDraft(db, {
    name: "Service Agreement",
    pdf: await tinyPdf(),
    signers: names.map((name) => ({ name, email: `${name}@example.com` })),
    ownerId: OWNER,
  });
  await sendDraft(db, draft.id, draft.manageToken);
  return draft;
};

const signersOf = (db: Db, documentId: string) =>
  db.select().from(signer).where(eq(signer.documentId, documentId));

const setStatus = (db: Db, id: string, status: string) =>
  db.update(signer).set({ status }).where(eq(signer.id, id));

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("addSignerToSentDocument", () => {
  test("appends an approver to a sent document and returns the name", async () => {
    const draft = await sentDoc(db, ["Alice"]);
    const added = await addSignerToSentDocument(db, draft.id, OWNER, [], {
      name: "Bob",
      email: "bob@example.com",
    });
    expect(added?.name).toBe("Bob");
    expect(added?.signToken).toBeString();
    expect(added?.documentName).toBe("Service Agreement");
    expect((await signersOf(db, draft.id)).length).toBe(2);
  });

  test("refuses to add on a draft (not sent)", async () => {
    const draft = await createDraft(db, {
      name: "Draft",
      pdf: await tinyPdf(),
      signers: [{ name: "Alice" }],
      ownerId: OWNER,
    });
    const added = await addSignerToSentDocument(db, draft.id, OWNER, [], {
      name: "Bob",
    });
    expect(added).toBeNull();
  });

  test("refuses to add for a non-owner", async () => {
    const draft = await sentDoc(db, ["Alice"]);
    const added = await addSignerToSentDocument(db, draft.id, "other", [], {
      name: "Bob",
    });
    expect(added).toBeNull();
  });
});

describe("removePendingSignerFromSent", () => {
  test("removes a still-pending signer", async () => {
    const draft = await sentDoc(db, ["Alice", "Bob"]);
    const bob = (await signersOf(db, draft.id)).find((s) => s.name === "Bob");
    const ok = await removePendingSignerFromSent(
      db,
      draft.id,
      OWNER,
      [],
      bob?.id ?? "",
    );
    expect(ok).toBe(true);
    const remaining = await signersOf(db, draft.id);
    expect(remaining.map((s) => s.name)).toEqual(["Alice"]);
    expect(remaining[0]?.orderIndex).toBe(0);
  });

  test("refuses to remove a signer who already signed", async () => {
    const draft = await sentDoc(db, ["Alice", "Bob"]);
    const bob = (await signersOf(db, draft.id)).find((s) => s.name === "Bob");
    if (bob) await setStatus(db, bob.id, "signed");
    const ok = await removePendingSignerFromSent(
      db,
      draft.id,
      OWNER,
      [],
      bob?.id ?? "",
    );
    expect(ok).toBe(false);
  });

  test("refuses to remove the last signer", async () => {
    const draft = await sentDoc(db, ["Alice"]);
    const alice = (await signersOf(db, draft.id))[0];
    const ok = await removePendingSignerFromSent(
      db,
      draft.id,
      OWNER,
      [],
      alice?.id ?? "",
    );
    expect(ok).toBe(false);
  });

  test("refuses a removal that would strand the document (all remaining signed)", async () => {
    const draft = await sentDoc(db, ["Alice", "Bob"]);
    const rows = await signersOf(db, draft.id);
    const alice = rows.find((s) => s.name === "Alice");
    const bob = rows.find((s) => s.name === "Bob");
    if (alice) await setStatus(db, alice.id, "signed");
    // removing the only pending signer (Bob) would leave only a signed Alice
    const ok = await removePendingSignerFromSent(
      db,
      draft.id,
      OWNER,
      [],
      bob?.id ?? "",
    );
    expect(ok).toBe(false);
  });

  test("refuses to remove for a non-owner", async () => {
    const draft = await sentDoc(db, ["Alice", "Bob"]);
    const bob = (await signersOf(db, draft.id)).find((s) => s.name === "Bob");
    const ok = await removePendingSignerFromSent(
      db,
      draft.id,
      "other",
      [],
      bob?.id ?? "",
    );
    expect(ok).toBe(false);
  });
});
