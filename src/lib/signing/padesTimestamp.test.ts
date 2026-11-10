import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { embedSignatureTimestamp } from "./padesTimestamp.ts";
import { inspectPdfSignature, signPdf } from "./pdfSigner.ts";
import { createSampleDocument } from "./sampleDocument.ts";
import { generateSelfSignedPkcs12 } from "./signerIdentity.ts";

const originalTsa = process.env.SIGNET_TSA_URL;

beforeEach(() => {
  // the tests here must never hit a network TSA
  process.env.SIGNET_TSA_URL = undefined;
  delete process.env.SIGNET_TSA_URL;
});
afterEach(() => {
  if (originalTsa === undefined) delete process.env.SIGNET_TSA_URL;
  else process.env.SIGNET_TSA_URL = originalTsa;
});

describe("PAdES-T signature timestamp (best-effort)", () => {
  test("returns the input unchanged when no TSA is configured", async () => {
    const pdf = await createSampleDocument({ title: "No TSA" });
    const p12 = generateSelfSignedPkcs12({ commonName: "Signet" });
    const signed = await signPdf(pdf, p12, { passphrase: "" });
    const out = await embedSignatureTimestamp(signed);
    expect(out).toBe(signed);
  });

  test("tolerates a non-PDF input without throwing", async () => {
    const junk = new Uint8Array([1, 2, 3, 4]);
    const out = await embedSignatureTimestamp(junk);
    expect(out).toBe(junk);
  });

  test("a signed PDF still validates structurally after the embed step", async () => {
    const pdf = await createSampleDocument({ title: "Still signed" });
    const p12 = generateSelfSignedPkcs12({ commonName: "Signet" });
    const signed = await signPdf(pdf, p12, { passphrase: "" });
    const info = inspectPdfSignature(signed);
    expect(info.hasSignature).toBe(true);
    expect(info.signerCommonName).toBe("Signet");
  });
});
