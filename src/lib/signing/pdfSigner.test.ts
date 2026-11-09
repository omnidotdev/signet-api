import { describe, expect, test } from "bun:test";
import { generateTestPkcs12 } from "../../test/testCerts.ts";
import { inspectPdfSignature, signPdf } from "./pdfSigner.ts";
import { createSampleDocument } from "./sampleDocument.ts";

describe("signPdf", () => {
  test("embeds a detached CMS signature into a PDF", async () => {
    const pdf = await createSampleDocument({ signerName: "Ada Lovelace" });
    const pkcs12 = generateTestPkcs12({ commonName: "Ada Lovelace" });

    const signed = await signPdf(pdf, pkcs12, {
      name: "Ada Lovelace",
      reason: "I agree to the terms",
    });

    // the signed document grows to accommodate the signature dictionary
    expect(signed.byteLength).toBeGreaterThan(pdf.byteLength);

    const raw = Buffer.from(signed).toString("latin1");
    expect(raw).toContain("/ByteRange");
    expect(raw).toContain("adbe.pkcs7.detached");
  });

  test("produces a signature that reports the signer identity", async () => {
    const pdf = await createSampleDocument();
    const pkcs12 = generateTestPkcs12({ commonName: "Grace Hopper" });

    const signed = await signPdf(pdf, pkcs12, { name: "Grace Hopper" });
    const info = inspectPdfSignature(signed);

    expect(info.hasSignature).toBe(true);
    expect(info.byteRange).toHaveLength(4);
    expect(info.byteRange[0]).toBe(0);
    expect(info.signerCommonName).toBe("Grace Hopper");
  });

  test("reports no signature for an unsigned PDF", async () => {
    const pdf = await createSampleDocument();
    const info = inspectPdfSignature(pdf);

    expect(info.hasSignature).toBe(false);
    expect(info.byteRange).toHaveLength(0);
  });

  test("honors a passphrase-protected PKCS#12 bundle", async () => {
    const pdf = await createSampleDocument();
    const pkcs12 = generateTestPkcs12({
      commonName: "Katherine Johnson",
      passphrase: "orbit",
    });

    const signed = await signPdf(pdf, pkcs12, {
      name: "Katherine Johnson",
      passphrase: "orbit",
    });
    const info = inspectPdfSignature(signed);

    expect(info.signerCommonName).toBe("Katherine Johnson");
  });
});
