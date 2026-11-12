import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { field, signer } from "../db/schema.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  addSignerToDraft,
  createDraft,
  getEditorData,
  removeSignerFromDraft,
  saveFields,
  sendDraft,
  signByToken,
  updateDraftSigner,
} from "./documentService.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const tinyPdf = async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

const newDraft = async (db: Db, names: string[]) =>
  createDraft(db, {
    name: "Operating Agreement",
    pdf: await tinyPdf(),
    signers: names.map((name) => ({ name })),
    ownerId: "owner-1",
  });

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("draft signer management", () => {
  test("adds a signer with its own token, color, and next order", async () => {
    const draft = await newDraft(db, ["Alice"]);
    const added = await addSignerToDraft(db, draft.id, draft.manageToken, {
      name: "Bob",
      email: "bob@example.com",
    });
    expect(added?.name).toBe("Bob");
    expect(added?.email).toBe("bob@example.com");
    expect(added?.signToken).toBeString();
    expect(added?.color).toBeTruthy();

    const editor = await getEditorData(db, draft.id, draft.manageToken);
    expect(editor?.signers.map((s) => s.name)).toEqual(["Alice", "Bob"]);
  });

  test("rejects a blank-named signer", async () => {
    const draft = await newDraft(db, ["Alice"]);
    expect(
      await addSignerToDraft(db, draft.id, draft.manageToken, { name: "  " }),
    ).toBeNull();
  });

  test("removing a signer deletes only their fields and renumbers order", async () => {
    const draft = await newDraft(db, ["Alice"]);
    const bob = await addSignerToDraft(db, draft.id, draft.manageToken, {
      name: "Bob",
    });
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    const alice = editor?.signers.find((s) => s.name === "Alice");

    await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId: alice?.id ?? null,
        type: "signature",
        page: 1,
        x: 10,
        y: 10,
        width: 80,
        height: 18,
      },
      {
        signerId: bob?.id ?? null,
        type: "signature",
        page: 1,
        x: 10,
        y: 40,
        width: 80,
        height: 18,
      },
    ]);

    expect(
      await removeSignerFromDraft(
        db,
        draft.id,
        draft.manageToken,
        bob?.id as string,
      ),
    ).toBe(true);

    // Bob's field is gone, Alice's remains
    const fields = await db
      .select()
      .from(field)
      .where(eq(field.documentId, draft.id));
    expect(fields).toHaveLength(1);
    expect(fields[0]?.signerId).toBe(alice?.id as string);

    // Alice is renumbered to order 0
    const [aliceRow] = await db
      .select()
      .from(signer)
      .where(
        and(
          eq(signer.documentId, draft.id),
          eq(signer.id, alice?.id as string),
        ),
      );
    expect(aliceRow?.orderIndex).toBe(0);
  });

  test("refuses to remove the last signer", async () => {
    const draft = await newDraft(db, ["Alice"]);
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    const alice = editor?.signers[0];
    expect(
      await removeSignerFromDraft(
        db,
        draft.id,
        draft.manageToken,
        alice?.id as string,
      ),
    ).toBe(false);
  });

  test("updates a signer's name and email", async () => {
    const draft = await newDraft(db, ["Alice"]);
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    const alice = editor?.signers[0];
    expect(
      await updateDraftSigner(
        db,
        draft.id,
        draft.manageToken,
        alice?.id as string,
        {
          name: "Alice Cooper",
          email: "alice@example.com",
        },
      ),
    ).toBe(true);
    const after = await getEditorData(db, draft.id, draft.manageToken);
    expect(after?.signers[0]?.name).toBe("Alice Cooper");
    expect(after?.signers[0]?.email).toBe("alice@example.com");
  });

  test("the signer roster is locked once the document is sent", async () => {
    const draft = await newDraft(db, ["Alice", "Bob"]);
    await sendDraft(db, draft.id, draft.manageToken);
    expect(
      await addSignerToDraft(db, draft.id, draft.manageToken, {
        name: "Carol",
      }),
    ).toBeNull();
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    const alice = editor?.signers[0];
    expect(
      await removeSignerFromDraft(
        db,
        draft.id,
        draft.manageToken,
        alice?.id as string,
      ),
    ).toBe(false);
    expect(
      await updateDraftSigner(
        db,
        draft.id,
        draft.manageToken,
        alice?.id as string,
        {
          name: "X",
        },
      ),
    ).toBe(false);
  });

  test("a wrong manage token cannot change signers", async () => {
    const draft = await newDraft(db, ["Alice"]);
    expect(
      await addSignerToDraft(db, draft.id, "wrong-token", { name: "Bob" }),
    ).toBeNull();
  });

  test("end to end: build a two-party agreement by adding the counterparty", async () => {
    const draft = await newDraft(db, ["Alice"]);
    const bob = await addSignerToDraft(db, draft.id, draft.manageToken, {
      name: "Bob",
      email: "bob@example.com",
    });
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    const alice = editor?.signers.find((s) => s.name === "Alice");
    await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId: alice?.id ?? null,
        type: "signature",
        page: 1,
        x: 10,
        y: 10,
        width: 80,
        height: 18,
      },
      {
        signerId: bob?.id ?? null,
        type: "signature",
        page: 1,
        x: 10,
        y: 40,
        width: 80,
        height: 18,
      },
    ]);

    const sent = await sendDraft(db, draft.id, draft.manageToken);
    expect(sent?.signers).toHaveLength(2);
    const tokens = sent?.signers.map((s) => s.signToken) ?? [];

    const first = await signByToken(
      db,
      serviceSigner,
      tokens[0] as string,
      "Alice",
      { consent: true },
    );
    expect(first.ok).toBe(true);
    expect(first.completed).toBe(false);
    const second = await signByToken(
      db,
      serviceSigner,
      tokens[1] as string,
      "Bob",
      { consent: true },
    );
    expect(second.ok).toBe(true);
    expect(second.completed).toBe(true);
  });
});
