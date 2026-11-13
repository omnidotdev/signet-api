import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { signer } from "../db/schema.ts";
import {
  getUserSignature,
  saveUserSignature,
} from "../signatures/userSignature.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createSigningRequest,
  getSignedPdf,
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
  page.drawText("Signature: ______________________", {
    x: 72,
    y: 220,
    size: 12,
    font,
  });
  return doc.save();
};

const fontNames = async (pdf: Uint8Array): Promise<string[]> => {
  const doc = await PDFDocument.load(pdf);
  const names: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const base = obj.get(PDFName.of("BaseFont"));
    if (base instanceof PDFName) names.push(base.asString());
  }
  return names;
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("typed signature handwriting style", () => {
  test("the sealed PDF carries the signer's chosen handwriting face", async () => {
    const req = await createSigningRequest(db, {
      name: "Agreement",
      pdf: await anchorPdf(),
      signerName: "Ada Lovelace",
    });
    const result = await signByToken(
      db,
      serviceSigner,
      req.signToken,
      "Ada Lovelace",
      { consent: true, signatureFont: "dafoe" },
    );
    expect(result.ok).toBe(true);

    const signed = await getSignedPdf(db, req.id, req.manageToken);
    const names = await fontNames(signed as Uint8Array);
    expect(names.some((n) => n.includes("MrDafoe"))).toBe(true);
  });

  test("an unrecognized style is stored as the classic default", async () => {
    const req = await createSigningRequest(db, {
      name: "Agreement",
      pdf: await anchorPdf(),
      signerName: "Ada Lovelace",
    });
    await signByToken(db, serviceSigner, req.signToken, "Ada Lovelace", {
      consent: true,
      signatureFont: "../../etc/passwd",
    });
    const [row] = await db
      .select({ font: signer.signatureFont })
      .from(signer)
      .where(eq(signer.signToken, req.signToken));
    expect(row?.font).toBeNull();
  });

  test("a saved signature remembers its handwriting style", async () => {
    await saveUserSignature(db, "user-1", {
      typedName: "Ada Lovelace",
      image: null,
      mode: "type",
      font: "homemade",
    });
    expect((await getUserSignature(db, "user-1"))?.font).toBe("homemade");
    await saveUserSignature(db, "user-1", {
      typedName: "Ada Lovelace",
      image: null,
      mode: "type",
      font: "not-a-font",
    });
    expect((await getUserSignature(db, "user-1"))?.font).toBeNull();
  });
});
