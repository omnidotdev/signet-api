import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { signer } from "../db/schema.ts";
import {
  addSignerForOwner,
  createDraft,
  removeSignerForOwner,
  sendDraft,
  updateSignerForOwner,
} from "./documentService.ts";

const OWNER = "owner-1";

const tinyPdf = async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

const draftWith = async (db: Db, names: string[]) =>
  createDraft(db, {
    name: "Operating Agreement",
    pdf: await tinyPdf(),
    signers: names.map((name) => ({ name })),
    ownerId: OWNER,
  });

const signersOf = (db: Db, documentId: string) =>
  db.select().from(signer).where(eq(signer.documentId, documentId));

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("owner-scoped draft signer management", () => {
  test("adds a signer to a draft the owner owns", async () => {
    const draft = await draftWith(db, ["Alice"]);
    const added = await addSignerForOwner(db, draft.id, OWNER, [], {
      name: "Bob",
      email: "bob@example.com",
    });
    expect(added?.name).toBe("Bob");
    expect(added?.email).toBe("bob@example.com");
    expect(added?.signToken).toBeString();
    expect(added?.color).toBeTruthy();
    expect((await signersOf(db, draft.id)).length).toBe(2);
  });

  test("refuses to add for a non-owner", async () => {
    const draft = await draftWith(db, ["Alice"]);
    const added = await addSignerForOwner(db, draft.id, "someone-else", [], {
      name: "Bob",
    });
    expect(added).toBeNull();
    expect((await signersOf(db, draft.id)).length).toBe(1);
  });

  test("refuses to add once the document is sent", async () => {
    const draft = await draftWith(db, ["Alice"]);
    await sendDraft(db, draft.id, draft.manageToken);
    const added = await addSignerForOwner(db, draft.id, OWNER, [], {
      name: "Bob",
    });
    expect(added).toBeNull();
  });

  test("edits a signer's name and email", async () => {
    const draft = await draftWith(db, ["Alice"]);
    const [alice] = await signersOf(db, draft.id);
    const ok = await updateSignerForOwner(
      db,
      draft.id,
      OWNER,
      [],
      alice?.id ?? "",
      {
        name: "Alicia",
        email: "alicia@example.com",
      },
    );
    expect(ok).toBe(true);
    const [row] = await signersOf(db, draft.id);
    expect(row?.name).toBe("Alicia");
    expect(row?.email).toBe("alicia@example.com");
  });

  test("removes a signer and keeps the order contiguous", async () => {
    const draft = await draftWith(db, ["Alice", "Bob", "Carol"]);
    const rows = await signersOf(db, draft.id);
    const bob = rows.find((s) => s.name === "Bob");
    const ok = await removeSignerForOwner(
      db,
      draft.id,
      OWNER,
      [],
      bob?.id ?? "",
    );
    expect(ok).toBe(true);
    const remaining = (await signersOf(db, draft.id)).sort(
      (a, b) => a.orderIndex - b.orderIndex,
    );
    expect(remaining.map((s) => s.name)).toEqual(["Alice", "Carol"]);
    expect(remaining.map((s) => s.orderIndex)).toEqual([0, 1]);
  });

  test("refuses to remove the last signer", async () => {
    const draft = await draftWith(db, ["Alice"]);
    const [alice] = await signersOf(db, draft.id);
    const ok = await removeSignerForOwner(
      db,
      draft.id,
      OWNER,
      [],
      alice?.id ?? "",
    );
    expect(ok).toBe(false);
    expect((await signersOf(db, draft.id)).length).toBe(1);
  });

  test("refuses to remove for a non-owner", async () => {
    const draft = await draftWith(db, ["Alice", "Bob"]);
    const bob = (await signersOf(db, draft.id)).find((s) => s.name === "Bob");
    const ok = await removeSignerForOwner(
      db,
      draft.id,
      "someone-else",
      [],
      bob?.id ?? "",
    );
    expect(ok).toBe(false);
    expect((await signersOf(db, draft.id)).length).toBe(2);
  });
});
