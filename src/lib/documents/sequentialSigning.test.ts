import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createDraft,
  getEditorData,
  getSignerFillData,
  saveFields,
  sendDraft,
  signByToken,
} from "./documentService.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const blankPdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("ORDERED AGREEMENT", { x: 72, y: 720, size: 16, font });
  return doc.save();
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("sequential signing", () => {
  test("enforces order and routes to the next signer", async () => {
    const draft = await createDraft(db, {
      name: "Ordered",
      pdf: await blankPdf(),
      signers: [
        { name: "First Signer" },
        { name: "Second Signer", email: "second@example.com" },
      ],
      signingMode: "sequential",
    });
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    const [a, b] = editor?.signers ?? [];
    await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId: a?.id ?? null,
        type: "signature",
        page: 1,
        x: 100,
        y: 400,
        width: 150,
        height: 18,
      },
      {
        signerId: b?.id ?? null,
        type: "signature",
        page: 1,
        x: 100,
        y: 300,
        width: 150,
        height: 18,
      },
    ]);

    const sent = await sendDraft(db, draft.id, draft.manageToken);
    // only the first signer is active for emailing
    expect(sent?.signers[0]?.active).toBe(true);
    expect(sent?.signers[1]?.active).toBe(false);
    const tokenA = sent?.signers[0]?.signToken as string;
    const tokenB = sent?.signers[1]?.signToken as string;

    // the second signer is told to wait and cannot sign out of order
    const bView = await getSignerFillData(db, tokenB);
    expect(bView?.waitingFor).toBe("First Signer");
    expect((await signByToken(db, serviceSigner, tokenB)).error).toBe(
      "out_of_order",
    );

    // first signer signs: not complete, and the next signer is handed off
    const first = await signByToken(db, serviceSigner, tokenA);
    expect(first.ok).toBe(true);
    expect(first.completed).toBe(false);
    expect(first.notifySigner?.email).toBe("second@example.com");

    // now it is the second signer's turn
    const bView2 = await getSignerFillData(db, tokenB);
    expect(bView2?.waitingFor).toBeNull();
    const second = await signByToken(db, serviceSigner, tokenB);
    expect(second.completed).toBe(true);
  });

  test("parallel mode lets signers sign in any order", async () => {
    const draft = await createDraft(db, {
      name: "Parallel",
      pdf: await blankPdf(),
      signers: [{ name: "A" }, { name: "B" }],
      signingMode: "parallel",
    });
    const sent = await sendDraft(db, draft.id, draft.manageToken);
    expect(sent?.signers.every((s) => s.active)).toBe(true);
    const tokenB = sent?.signers[1]?.signToken as string;
    // the second signer can sign first in parallel mode
    expect((await signByToken(db, serviceSigner, tokenB)).ok).toBe(true);
  });
});
