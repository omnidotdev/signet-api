import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  inspectPdfSignature,
  signPdf,
} from "../lib/signing/pdfSigner.ts";
import { createSampleDocument } from "../lib/signing/sampleDocument.ts";
import { appendEvent, verifyLedger } from "../lib/provenance/ledger.ts";
import { generateTestPkcs12 } from "../test/testCerts.ts";

/**
 * End-to-end local demonstration of the Signet signing core.
 *
 * Build a document, sign it, record the provenance chain, and write the
 * unsigned and signed PDFs plus a provenance record to disk for inspection
 */
const main = async () => {
  const signerName = "Ada Lovelace";
  const outDir = join(homedir(), "Downloads", "signet-demo");
  await mkdir(outDir, { recursive: true });

  const unsigned = await createSampleDocument({
    title: "Mutual Non-Disclosure Agreement",
    body: "The parties agree to keep confidential information private.",
    signerName,
  });
  const contentHash = createHash("sha256").update(unsigned).digest("hex");

  const pkcs12 = generateTestPkcs12({ commonName: signerName });
  const signed = await signPdf(unsigned, pkcs12, {
    name: signerName,
    reason: "I agree to the terms of this agreement",
    location: "Remote",
  });

  const info = inspectPdfSignature(signed);

  let ledger = appendEvent([], {
    type: "document.created",
    data: { contentHash, title: "Mutual Non-Disclosure Agreement" },
  });
  ledger = appendEvent(ledger, {
    type: "document.signed",
    data: { signer: signerName, contentHash },
  });
  const verification = verifyLedger(ledger);

  const unsignedPath = join(outDir, "agreement-unsigned.pdf");
  const signedPath = join(outDir, "agreement-signed.pdf");
  const ledgerPath = join(outDir, "provenance.json");

  await writeFile(unsignedPath, unsigned);
  await writeFile(signedPath, signed);
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));

  console.log("Signet signing demo complete\n");
  console.log(`  signer:            ${info.signerCommonName}`);
  console.log(`  signature present: ${info.hasSignature}`);
  console.log(`  byte range:        [${info.byteRange.join(", ")}]`);
  console.log(`  content sha256:    ${contentHash}`);
  console.log(`  ledger valid:      ${verification.valid}\n`);
  console.log("  files:");
  console.log(`    ${unsignedPath}`);
  console.log(`    ${signedPath}`);
  console.log(`    ${ledgerPath}`);
};

await main();
