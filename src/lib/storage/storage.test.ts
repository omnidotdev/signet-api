import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { document } from "../db/schema.ts";
import {
  createSigningRequest,
  getEditorData,
  getSignedPdf,
  getSignerFillData,
  signByToken,
} from "../documents/documentService.ts";
import { inspectPdfSignature } from "../signing/pdfSigner.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import type { PdfBackend } from "./pdfStore.ts";
import { setPdfBackend } from "./pdfStore.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const tinyPdf = async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

/** An in-memory object store standing in for S3 */
const memoryBackend = () => {
  const objects = new Map<string, Uint8Array>();
  const backend: PdfBackend = {
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => {
      objects.delete(key);
    },
  };
  return { backend, objects };
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(() => {
  // never leak the test backend into other suites in the same process
  setPdfBackend(null);
});

describe("PDF object storage", () => {
  test("externalizes the original PDF: nothing inline, bytes in the store", async () => {
    const { backend, objects } = memoryBackend();
    setPdfBackend(backend);

    const pdf = await tinyPdf();
    const req = await createSigningRequest(db, {
      name: "D",
      pdf,
      signerName: "Ada",
    });

    const [row] = await db
      .select()
      .from(document)
      .where(eq(document.id, req.id));
    expect(row?.originalPdf).toBe("");
    expect(row?.originalPdfKey).toBe(`documents/${req.id}/original.pdf`);
    expect(objects.has(`documents/${req.id}/original.pdf`)).toBe(true);
  });

  test("the editor and signer views load the PDF back from the store", async () => {
    const { backend } = memoryBackend();
    setPdfBackend(backend);

    const pdf = await tinyPdf();
    const expected = Buffer.from(pdf).toString("base64");
    const req = await createSigningRequest(db, {
      name: "D",
      pdf,
      signerName: "Ada",
      ownerId: "owner-1",
    });

    const editor = await getEditorData(db, req.id, req.manageToken);
    expect(editor?.pdfBase64).toBe(expected);

    const fill = await getSignerFillData(db, req.signToken);
    expect(fill?.pdfBase64).toBe(expected);
  });

  test("the sealed PDF is stored externally and downloads intact", async () => {
    const { backend, objects } = memoryBackend();
    setPdfBackend(backend);

    const req = await createSigningRequest(db, {
      name: "D",
      pdf: await tinyPdf(),
      signerName: "Ada",
    });
    const result = await signByToken(
      db,
      serviceSigner,
      req.signToken,
      undefined,
      { consent: true },
    );
    expect(result.ok).toBe(true);
    expect(result.completed).toBe(true);

    const [row] = await db
      .select()
      .from(document)
      .where(eq(document.id, req.id));
    expect(row?.signedPdf).toBe("");
    expect(row?.signedPdfKey).toBe(`documents/${req.id}/signed.pdf`);
    expect(objects.has(`documents/${req.id}/signed.pdf`)).toBe(true);

    const signed = await getSignedPdf(db, req.id, req.manageToken);
    expect(signed).not.toBeNull();
    expect(inspectPdfSignature(signed as Uint8Array).hasSignature).toBe(true);
  });

  test("with no backend, PDFs stay inline (base64) in the row", async () => {
    // default: no backend configured
    const req = await createSigningRequest(db, {
      name: "D",
      pdf: await tinyPdf(),
      signerName: "Ada",
    });
    const [row] = await db
      .select()
      .from(document)
      .where(eq(document.id, req.id));
    expect(row?.originalPdfKey).toBeNull();
    expect(row?.originalPdf.length).toBeGreaterThan(0);
  });
});
