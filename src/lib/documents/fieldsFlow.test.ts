import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { extractText } from "../fields/detect.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createSigningRequest,
  getSignedPdf,
  getSignerView,
  signByToken,
} from "./documentService.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const anchorPdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("SERVICE AGREEMENT", { x: 72, y: 720, size: 16, font });
  page.drawText("Signature: ______________________", {
    x: 72,
    y: 220,
    size: 12,
    font,
  });
  page.drawText("Date: ______________", { x: 72, y: 190, size: 12, font });
  return doc.save();
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("send-for-signature with auto-detected fields", () => {
  test("detects fields on create and stamps them on sign", async () => {
    const req = await createSigningRequest(db, {
      name: "Service Agreement",
      pdf: await anchorPdf(),
      signerName: "Grace Hopper",
    });

    // the signer sees a summary of detected fields
    const view = await getSignerView(db, req.signToken);
    expect(view?.fields.signature).toBeGreaterThanOrEqual(1);
    expect(view?.fields.date).toBeGreaterThanOrEqual(1);

    // the signer adopts a typed signature
    const result = await signByToken(
      db,
      serviceSigner,
      req.signToken,
      "Grace B. Hopper",
    );
    expect(result.ok).toBe(true);

    // the signed document carries the stamped signature and today's date
    const signed = await getSignedPdf(db, req.id, req.manageToken);
    expect(signed).toBeInstanceOf(Uint8Array);
    const text = await extractText(signed as Uint8Array);
    expect(text).toContain("Grace B. Hopper");
    expect(text).toContain(new Date().toISOString().slice(0, 10));
  });

  test("a document with no anchors still signs, with no fields", async () => {
    const plain = await PDFDocument.create();
    const page = plain.addPage([612, 792]);
    const font = await plain.embedFont(StandardFonts.Helvetica);
    page.drawText("Nothing to fill here.", { x: 72, y: 700, size: 12, font });

    const req = await createSigningRequest(db, {
      name: "Plain",
      pdf: await plain.save(),
      signerName: "Ada",
    });
    const view = await getSignerView(db, req.signToken);
    expect(view?.fields.signature).toBe(0);

    const result = await signByToken(db, serviceSigner, req.signToken);
    expect(result.ok).toBe(true);
    expect(await getSignedPdf(db, req.id, req.manageToken)).toBeInstanceOf(
      Uint8Array,
    );
  });
});
