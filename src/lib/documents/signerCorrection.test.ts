import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { signer } from "../db/schema.ts";
import {
  correctOwnedSigner,
  createDraft,
  sendDraft,
} from "./documentService.ts";

const OWNER = "owner-1";

const tinyPdf = async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

/** A sent document with Alice and a mistyped Bob, plus the signer rows */
const sentDoc = async (db: Db) => {
  const draft = await createDraft(db, {
    name: "Mutual NDA",
    pdf: await tinyPdf(),
    signers: [
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "bob@exmaple.com" },
    ],
    ownerId: OWNER,
  });
  await sendDraft(db, draft.id, draft.manageToken);
  const signers = await db
    .select()
    .from(signer)
    .where(eq(signer.documentId, draft.id));
  const bob = signers.find((s) => s.name === "Bob");
  if (!bob) throw new Error("expected a Bob signer");
  return { draft, bob };
};

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("correctOwnedSigner", () => {
  test("fixes a name without rotating the signing link", async () => {
    const { draft, bob } = await sentDoc(db);
    const result = await correctOwnedSigner(db, draft.id, OWNER, [], bob.id, {
      name: "Bob Jones",
    });
    expect(result?.name).toBe("Bob Jones");
    expect(result?.reissued).toBe(false);
    expect(result?.signToken).toBe(bob.signToken);

    const [row] = await db.select().from(signer).where(eq(signer.id, bob.id));
    expect(row?.name).toBe("Bob Jones");
    expect(row?.signToken).toBe(bob.signToken);
  });

  test("reissues the signing link when the email changes", async () => {
    const { draft, bob } = await sentDoc(db);
    const result = await correctOwnedSigner(db, draft.id, OWNER, [], bob.id, {
      email: "bob@example.com",
    });
    expect(result?.email).toBe("bob@example.com");
    expect(result?.reissued).toBe(true);
    expect(result?.signToken).not.toBe(bob.signToken);

    // the old capability token no longer belongs to anyone
    const [byOld] = await db
      .select()
      .from(signer)
      .where(eq(signer.signToken, bob.signToken));
    expect(byOld).toBeUndefined();
  });

  test("does not rotate the link when the email is unchanged", async () => {
    const { draft, bob } = await sentDoc(db);
    const result = await correctOwnedSigner(db, draft.id, OWNER, [], bob.id, {
      email: bob.email,
    });
    expect(result?.reissued).toBe(false);
    expect(result?.signToken).toBe(bob.signToken);
  });

  test("refuses to change a signer who already signed", async () => {
    const { draft, bob } = await sentDoc(db);
    await db
      .update(signer)
      .set({ status: "signed" })
      .where(eq(signer.id, bob.id));
    const result = await correctOwnedSigner(db, draft.id, OWNER, [], bob.id, {
      name: "Too Late",
    });
    expect(result).toBeNull();
  });

  test("refuses to change a signer who declined", async () => {
    const { draft, bob } = await sentDoc(db);
    await db
      .update(signer)
      .set({ status: "declined" })
      .where(eq(signer.id, bob.id));
    const result = await correctOwnedSigner(db, draft.id, OWNER, [], bob.id, {
      email: "bob@example.com",
    });
    expect(result).toBeNull();
  });

  test("refuses on a document that has not been sent", async () => {
    const draft = await createDraft(db, {
      name: "Draft NDA",
      pdf: await tinyPdf(),
      signers: [{ name: "Alice", email: "alice@example.com" }],
      ownerId: OWNER,
    });
    const [alice] = await db
      .select()
      .from(signer)
      .where(eq(signer.documentId, draft.id));
    const result = await correctOwnedSigner(
      db,
      draft.id,
      OWNER,
      [],
      alice?.id ?? "",
      { name: "Alicia" },
    );
    expect(result).toBeNull();
  });

  test("refuses when the caller does not own the document", async () => {
    const { draft, bob } = await sentDoc(db);
    const result = await correctOwnedSigner(
      db,
      draft.id,
      "someone-else",
      [],
      bob.id,
      { name: "Hijack" },
    );
    expect(result).toBeNull();

    const [row] = await db.select().from(signer).where(eq(signer.id, bob.id));
    expect(row?.name).toBe("Bob");
  });

  test("rejects a blank name", async () => {
    const { draft, bob } = await sentDoc(db);
    const result = await correctOwnedSigner(db, draft.id, OWNER, [], bob.id, {
      name: "   ",
    });
    expect(result).toBeNull();
    const [row] = await db
      .select()
      .from(signer)
      .where(and(eq(signer.id, bob.id), eq(signer.documentId, draft.id)));
    expect(row?.name).toBe("Bob");
  });
});
