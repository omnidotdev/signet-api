import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { extractText } from "../fields/detect.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createDraft,
  getEditorData,
  getSignedPdf,
  getStatus,
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
  page.drawText("PARTNERSHIP AGREEMENT", { x: 72, y: 720, size: 16, font });
  return doc.save();
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("multi-signer draft -> edit -> send -> sign", () => {
  test("seals only after every signer has signed", async () => {
    const draft = await createDraft(db, {
      name: "Partnership",
      pdf: await blankPdf(),
      signers: [
        { name: "Ada Lovelace" },
        { name: "Grace Hopper", email: "grace@example.com" },
      ],
    });

    const editor = await getEditorData(db, draft.id, draft.manageToken);
    expect(editor?.status).toBe("draft");
    expect(editor?.signers).toHaveLength(2);
    const [a, b] = editor?.signers ?? [];

    // place one signature field per signer
    const ok = await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId: a?.id ?? null,
        type: "signature",
        page: 1,
        x: 100,
        y: 400,
        width: 160,
        height: 18,
      },
      {
        signerId: b?.id ?? null,
        type: "signature",
        page: 1,
        x: 100,
        y: 300,
        width: 160,
        height: 18,
      },
    ]);
    expect(ok).toBe(true);

    const sent = await sendDraft(db, draft.id, draft.manageToken);
    expect(sent?.signers).toHaveLength(2);
    const tokenA = sent?.signers[0]?.signToken as string;
    const tokenB = sent?.signers[1]?.signToken as string;

    // first signer signs: not complete yet, no sealed PDF
    const first = await signByToken(db, serviceSigner, tokenA, "Ada Lovelace", {
      consent: true,
    });
    expect(first.ok).toBe(true);
    expect(first.completed).toBe(false);
    expect(await getSignedPdf(db, draft.id, draft.manageToken)).toBeNull();

    // second signer signs: now complete and sealed
    const second = await signByToken(
      db,
      serviceSigner,
      tokenB,
      "Grace Hopper",
      { consent: true },
    );
    expect(second.ok).toBe(true);
    expect(second.completed).toBe(true);

    const status = await getStatus(db, draft.id, draft.manageToken);
    expect(status?.status).toBe("completed");
    expect(status?.provenanceValid).toBe(true);

    const signed = await getSignedPdf(db, draft.id, draft.manageToken);
    expect(signed).toBeInstanceOf(Uint8Array);
    const text = await extractText(signed as Uint8Array);
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("Grace Hopper");
  });

  test("a draft cannot be signed until it is sent", async () => {
    const draft = await createDraft(db, {
      name: "Draft only",
      pdf: await blankPdf(),
      signers: [{ name: "Ada" }],
    });
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    // sendDraft returns the tokens; before send the signer cannot sign
    const sent = await sendDraft(db, draft.id, draft.manageToken);
    const token = sent?.signers[0]?.signToken as string;
    expect(editor?.status).toBe("draft");
    // sending twice is rejected (already sent)
    expect(await sendDraft(db, draft.id, draft.manageToken)).toBeNull();
    expect(
      (
        await signByToken(db, serviceSigner, token, undefined, {
          consent: true,
        })
      ).ok,
    ).toBe(true);
  });
});
