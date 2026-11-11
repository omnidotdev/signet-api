import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { extractText } from "../fields/detect.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  buildCertificateForToken,
  createDraft,
  getSignedPdf,
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

// a minimal valid 1x1 PNG
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const blankPdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("CONTRACT", { x: 72, y: 720, size: 16, font });
  return doc.save();
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("signer fill overlay", () => {
  test("serves the PDF and this signer's fields", async () => {
    const draft = await createDraft(db, {
      name: "Contract",
      pdf: await blankPdf(),
      signers: [{ name: "Ada" }],
    });
    const editorSigners = (await getSignerFillData(db, "nope")) ?? null;
    expect(editorSigners).toBeNull();

    // place a signature + a text field for the signer
    const [a] =
      (
        await import("./documentService.ts").then((m) =>
          m.getEditorData(db, draft.id, draft.manageToken),
        )
      )?.signers ?? [];
    await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId: a?.id ?? null,
        type: "signature",
        page: 1,
        x: 100,
        y: 400,
        width: 160,
        height: 20,
      },
      {
        signerId: a?.id ?? null,
        type: "text",
        page: 1,
        x: 100,
        y: 350,
        width: 200,
        height: 18,
      },
    ]);
    const sent = await sendDraft(db, draft.id, draft.manageToken);
    const token = sent?.signers[0]?.signToken as string;

    const fill = await getSignerFillData(db, token);
    expect(fill?.pdfBase64.length).toBeGreaterThan(0);
    expect(fill?.fields).toHaveLength(2);
    expect(fill?.fields.map((f) => f.type).sort()).toEqual([
      "signature",
      "text",
    ]);
  });

  test("stamps a drawn signature and a typed text field, then seals", async () => {
    const draft = await createDraft(db, {
      name: "Contract",
      pdf: await blankPdf(),
      signers: [{ name: "Ada" }],
    });
    const data = await import("./documentService.ts").then((m) =>
      m.getEditorData(db, draft.id, draft.manageToken),
    );
    const signerId = data?.signers[0]?.id ?? null;
    await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId,
        type: "signature",
        page: 1,
        x: 100,
        y: 400,
        width: 160,
        height: 20,
      },
      {
        signerId,
        type: "text",
        page: 1,
        x: 100,
        y: 350,
        width: 200,
        height: 18,
      },
    ]);
    const sent = await sendDraft(db, draft.id, draft.manageToken);
    const token = sent?.signers[0]?.signToken as string;

    const fill = await getSignerFillData(db, token);
    const textField = fill?.fields.find((f) => f.type === "text");

    const result = await signByToken(db, serviceSigner, token, "Ada Lovelace", {
      signatureImage: PNG_1X1,
      textValues: textField ? { [textField.id]: "Acme Corp" } : {},
    });
    expect(result.ok).toBe(true);
    expect(result.completed).toBe(true);

    const signed = await getSignedPdf(db, draft.id, draft.manageToken);
    expect(signed).toBeInstanceOf(Uint8Array);
    // the typed text field is stamped; the signature is a drawn image
    expect(await extractText(signed as Uint8Array)).toContain("Acme Corp");
  });

  test("produces a certificate of completion only once completed", async () => {
    const draft = await createDraft(db, {
      name: "Contract",
      pdf: await blankPdf(),
      signers: [{ name: "Ada" }],
    });
    const data = await import("./documentService.ts").then((m) =>
      m.getEditorData(db, draft.id, draft.manageToken),
    );
    await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId: data?.signers[0]?.id ?? null,
        type: "signature",
        page: 1,
        x: 100,
        y: 400,
        width: 160,
        height: 20,
      },
    ]);
    const sent = await sendDraft(db, draft.id, draft.manageToken);
    const token = sent?.signers[0]?.signToken as string;

    // not complete yet: no certificate
    expect(await buildCertificateForToken(db, token)).toBeNull();

    const result = await signByToken(db, serviceSigner, token, "Ada Lovelace", {
      signatureImage: PNG_1X1,
      consent: true,
    });
    expect(result.completed).toBe(true);

    const cert = await buildCertificateForToken(db, token);
    expect(cert).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode((cert as Uint8Array).slice(0, 5))).toBe(
      "%PDF-",
    );
    const parsed = await PDFDocument.load(cert as Uint8Array);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
