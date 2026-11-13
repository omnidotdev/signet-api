import { beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { document, field, signatureEvent, signer } from "../db/schema.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createMultiSignerRequest,
  getDocumentDetailForOwner,
  reviseOwnedDocument,
  signByToken,
} from "./documentService.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

/** A contract with a signature line per party on each of `pages` pages */
const contract = async (
  pages: number,
  title = "Contract",
): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${title} page ${p + 1}`, { x: 72, y: 720, size: 14, font });
    page.drawText("Signature: ______________________", {
      x: 72,
      y: 260,
      size: 12,
      font,
    });
    page.drawText("Signature: ______________________", {
      x: 330,
      y: 260,
      size: 12,
      font,
    });
  }
  return doc.save();
};

const OWNER = "owner-1";
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

const sent = async (pages = 1) =>
  createMultiSignerRequest(db, {
    name: "Services agreement",
    pdf: await contract(pages),
    signers: [
      { name: "Ada", email: "ada@example.com" },
      { name: "Grace", email: "grace@example.com", accessCode: "1234" },
    ],
    signingMode: "sequential",
    ownerId: OWNER,
  });

const signersOf = (documentId: string) =>
  db
    .select()
    .from(signer)
    .where(eq(signer.documentId, documentId))
    .orderBy(asc(signer.orderIndex));

describe("revising a document with a new version", () => {
  test("an in-progress document is voided and a linked draft carries its setup", async () => {
    const v1 = await sent();
    const result = await reviseOwnedDocument(db, {
      id: v1.id,
      ownerId: OWNER,
      workspaceIds: [],
      pdf: await contract(1, "Contract v2"),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.voidedPrevious).toBe(true);

    const [old] = await db
      .select()
      .from(document)
      .where(eq(document.id, v1.id));
    expect(old?.status).toBe("voided");
    const oldEvents = await db
      .select()
      .from(signatureEvent)
      .where(eq(signatureEvent.documentId, v1.id));
    expect(oldEvents.some((e) => e.type === "document.voided")).toBe(true);

    const [next] = await db
      .select()
      .from(document)
      .where(eq(document.id, result.draft.id));
    expect(next?.status).toBe("draft");
    expect(next?.version).toBe(2);
    expect(next?.previousVersionId).toBe(v1.id);
    expect(next?.signingMode).toBe("sequential");
    expect(next?.ownerId).toBe(OWNER);

    // same signers, same order, same contact details and access codes
    const nextSigners = await signersOf(result.draft.id);
    expect(nextSigners.map((s) => [s.name, s.email, s.accessCode])).toEqual([
      ["Ada", "ada@example.com", null],
      ["Grace", "grace@example.com", "1234"],
    ]);
    // each carried field belongs to the matching new signer
    const oldFields = await db
      .select()
      .from(field)
      .where(eq(field.documentId, v1.id));
    const oldSigners = await signersOf(v1.id);
    const newFields = await db
      .select()
      .from(field)
      .where(eq(field.documentId, result.draft.id));
    expect(newFields).toHaveLength(oldFields.length);
    const nameOfOld = new Map(oldSigners.map((s) => [s.id, s.name]));
    const nameOfNew = new Map(nextSigners.map((s) => [s.id, s.name]));
    const key = (f: { x: number; y: number }) =>
      `${Math.round(f.x)},${Math.round(f.y)}`;
    const oldOwner = new Map(
      oldFields.map((f) => [key(f), nameOfOld.get(f.signerId ?? "")]),
    );
    for (const f of newFields) {
      expect(nameOfNew.get(f.signerId ?? "")).toBe(oldOwner.get(key(f)));
    }
  });

  test("a completed document stays sealed and untouched", async () => {
    const v1 = await sent();
    const [ada, grace] = await signersOf(v1.id);
    await signByToken(db, serviceSigner, ada?.signToken as string, "Ada", {
      consent: true,
    });
    await signByToken(db, serviceSigner, grace?.signToken as string, "Grace", {
      consent: true,
      accessCode: "1234",
    });
    const [before] = await db
      .select()
      .from(document)
      .where(eq(document.id, v1.id));
    expect(before?.status).toBe("completed");

    const result = await reviseOwnedDocument(db, {
      id: v1.id,
      ownerId: OWNER,
      workspaceIds: [],
      pdf: await contract(1, "Contract v2"),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.voidedPrevious).toBe(false);

    const [after] = await db
      .select()
      .from(document)
      .where(eq(document.id, v1.id));
    expect(after?.status).toBe("completed");
    expect(after?.signedPdf).toBe(before?.signedPdf);
    expect(after?.signedPdfKey).toBe(before?.signedPdfKey);
    // its sealed audit trail gains nothing
    const events = await db
      .select()
      .from(signatureEvent)
      .where(eq(signatureEvent.documentId, v1.id));
    expect(events.at(-1)?.type).not.toBe("document.voided");
  });

  test("fields on pages the new version no longer has are dropped", async () => {
    const v1 = await sent(2);
    const oldFields = await db
      .select()
      .from(field)
      .where(eq(field.documentId, v1.id));
    expect(oldFields.some((f) => f.page === 2)).toBe(true);

    const result = await reviseOwnedDocument(db, {
      id: v1.id,
      ownerId: OWNER,
      workspaceIds: [],
      pdf: await contract(1, "Shorter v2"),
    });
    if (!result.ok) throw new Error(result.error);
    const newFields = await db
      .select()
      .from(field)
      .where(eq(field.documentId, result.draft.id));
    expect(newFields.length).toBeGreaterThan(0);
    expect(newFields.every((f) => f.page === 1)).toBe(true);
  });

  test("history stays linear: drafts are edited, and a version is revised once", async () => {
    const draft = await createMultiSignerRequest(db, {
      name: "Draft",
      pdf: await contract(1),
      signers: [{ name: "Ada" }],
      ownerId: OWNER,
      draft: true,
    });
    expect(
      await reviseOwnedDocument(db, {
        id: draft.id,
        ownerId: OWNER,
        workspaceIds: [],
        pdf: await contract(1),
      }),
    ).toEqual({ ok: false, error: "draft_edit_instead" });

    const v1 = await sent();
    const first = await reviseOwnedDocument(db, {
      id: v1.id,
      ownerId: OWNER,
      workspaceIds: [],
      pdf: await contract(1),
    });
    expect(first.ok).toBe(true);
    expect(
      await reviseOwnedDocument(db, {
        id: v1.id,
        ownerId: OWNER,
        workspaceIds: [],
        pdf: await contract(1),
      }),
    ).toEqual({ ok: false, error: "already_revised" });
  });

  test("blanks the old version had no field for are detected and paired to the nearest signer", async () => {
    // an older document sent with signature fields only, on a page whose lines
    // read "______ Date: ______" (signature and date blank in one run)
    const lines = async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([612, 792]);
      for (const y of [490, 425]) {
        page.drawText(
          "________________________________________ Date: ______________",
          { x: 72, y, size: 11, font },
        );
      }
      return doc.save();
    };
    const v1 = await createMultiSignerRequest(db, {
      name: "Operating agreement",
      pdf: await lines(),
      signers: [{ name: "Ada" }, { name: "Grace" }],
      ownerId: OWNER,
    });
    const v1Signers = await signersOf(v1.id);
    // keep only the signatures, as the older detector produced
    await db.delete(field).where(eq(field.type, "date"));
    const v1Fields = await db
      .select()
      .from(field)
      .where(eq(field.documentId, v1.id));
    expect(v1Fields.map((f) => f.type)).toEqual(["signature", "signature"]);

    const result = await reviseOwnedDocument(db, {
      id: v1.id,
      ownerId: OWNER,
      workspaceIds: [],
      pdf: await lines(),
    });
    if (!result.ok) throw new Error(result.error);
    const nextSigners = await signersOf(result.draft.id);
    const nameOf = new Map(nextSigners.map((s) => [s.id, s.name]));
    const next = await db
      .select()
      .from(field)
      .where(eq(field.documentId, result.draft.id));
    const at = (type: string, y: number) =>
      next.find((f) => f.type === type && Math.abs(f.y - y) < 2);
    // the signatures carry over untouched, with no duplicate on top of them
    expect(next.filter((f) => f.type === "signature")).toHaveLength(2);
    expect(next.filter((f) => f.type === "date")).toHaveLength(2);
    // each date belongs to the signer of the signature on its line
    for (const y of [490, 425]) {
      expect(nameOf.get(at("date", y)?.signerId ?? "")).toBe(
        nameOf.get(at("signature", y)?.signerId ?? ""),
      );
    }
    const oldNameOf = new Map(v1Signers.map((s) => [s.id, s.name]));
    const oldSigAt = (y: number) =>
      oldNameOf.get(
        v1Fields.find((f) => Math.abs(f.y - y) < 2)?.signerId ?? "",
      );
    expect(nameOf.get(at("signature", 490)?.signerId ?? "")).toBe(
      oldSigAt(490),
    );
  });

  test("only the owner can revise", async () => {
    const v1 = await sent();
    expect(
      await reviseOwnedDocument(db, {
        id: v1.id,
        ownerId: "someone-else",
        workspaceIds: [],
        pdf: await contract(1),
      }),
    ).toEqual({ ok: false, error: "not_found" });
  });

  test("the detail view links versions both ways", async () => {
    const v1 = await sent();
    const result = await reviseOwnedDocument(db, {
      id: v1.id,
      ownerId: OWNER,
      workspaceIds: [],
      pdf: await contract(1),
    });
    if (!result.ok) throw new Error(result.error);
    const oldDetail = await getDocumentDetailForOwner(db, v1.id, OWNER, []);
    const newDetail = await getDocumentDetailForOwner(
      db,
      result.draft.id,
      OWNER,
      [],
    );
    expect(oldDetail?.version).toBe(1);
    expect(oldDetail?.nextVersionId).toBe(result.draft.id);
    expect(oldDetail?.previousVersionId).toBeNull();
    expect(newDetail?.version).toBe(2);
    expect(newDetail?.previousVersionId).toBe(v1.id);
    expect(newDetail?.nextVersionId).toBeNull();
  });
});
