import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { extractText } from "../fields/detect.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createDraft,
  getDocumentFileForOwner,
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
  page.drawText("SERVICES AGREEMENT", { x: 72, y: 720, size: 16, font });
  return doc.save();
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("a document out for signature", () => {
  test("shows the signatures collected so far before it is sealed", async () => {
    const draft = await createDraft(db, {
      name: "Services",
      pdf: await blankPdf(),
      ownerId: "alice",
      signers: [
        { name: "Ada Lovelace", email: "ada@example.com" },
        { name: "Grace Hopper", email: "grace@example.com" },
      ],
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
    const sent = await sendDraft(db, draft.id, draft.manageToken);
    const tokenA = sent?.signers[0]?.signToken as string;
    const tokenB = sent?.signers[1]?.signToken as string;

    // nobody has signed: the original, unchanged
    const before = await getDocumentFileForOwner(db, draft.id, "alice", []);
    expect(await extractText(before?.bytes as Uint8Array)).not.toContain(
      "Ada Lovelace",
    );
    expect(before?.name).toBe("Services");

    await signByToken(db, serviceSigner, tokenA, "Ada Lovelace", {
      consent: true,
    });

    // the sender's preview shows Ada's signature but not Grace's, unsealed
    const preview = await getDocumentFileForOwner(db, draft.id, "alice", []);
    expect(preview?.signed).toBe(false);
    const text = await extractText(preview?.bytes as Uint8Array);
    expect(text).toContain("Ada Lovelace");
    expect(text).not.toContain("Grace Hopper");

    // the next signer sees it too
    const fill = await getSignerFillData(db, tokenB);
    const fillText = await extractText(
      Uint8Array.from(Buffer.from(fill?.pdfBase64 ?? "", "base64")),
    );
    expect(fillText).toContain("Ada Lovelace");
  });
});
