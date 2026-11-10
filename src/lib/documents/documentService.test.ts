import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { field } from "../db/schema.ts";
import { inspectPdfSignature } from "../signing/pdfSigner.ts";
import { createSampleDocument } from "../signing/sampleDocument.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createMultiSignerRequest,
  createSigningRequest,
  deleteOwnedDocument,
  getSignedPdf,
  getSignerView,
  getStatus,
  sendOwnedDraft,
  signByToken,
  voidDocument,
} from "./documentService.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

let db: Db;
let pdf: Uint8Array;

beforeEach(async () => {
  db = await createTestDb();
  pdf = await createSampleDocument({ title: "NDA" });
});

const newRequest = () =>
  createSigningRequest(db, {
    name: "NDA",
    pdf,
    signerName: "Ada Lovelace",
    signerEmail: "ada@example.com",
  });

/** A PDF with two signature lines, for multi-party assignment tests */
const twoLinePdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("________________________________________ Date", {
    x: 64,
    y: 300,
    size: 12,
    font,
  });
  page.drawText("________________________________________ Date", {
    x: 64,
    y: 180,
    size: 12,
    font,
  });
  return doc.save();
};

describe("multi-signer send", () => {
  test("creates a sent request and gives each party their own signing line", async () => {
    const multiPdf = await twoLinePdf();
    const req = await createMultiSignerRequest(db, {
      name: "Operating Agreement",
      pdf: multiPdf,
      signers: [
        { name: "Ada Lovelace", email: "ada@example.com" },
        { name: "Grace Hopper", email: "grace@example.com" },
      ],
    });

    expect(req.signers).toHaveLength(2);
    expect(req.signers[0]?.signToken).toBeTruthy();
    expect(req.signers[1]?.signToken).not.toBe(req.signers[0]?.signToken);

    const status = await getStatus(db, req.id, req.manageToken);
    expect(status?.status).toBe("sent");

    // the two detected signature lines are assigned to different signers
    const sigFields = await db
      .select({ signerId: field.signerId, type: field.type })
      .from(field)
      .where(eq(field.documentId, req.id));
    const sigOnly = sigFields.filter((f) => f.type === "signature");
    expect(sigOnly.length).toBe(2);
    expect(new Set(sigOnly.map((f) => f.signerId)).size).toBe(2);
  });

  test("both signers can sign and the document seals once", async () => {
    const multiPdf = await twoLinePdf();
    const req = await createMultiSignerRequest(db, {
      name: "Operating Agreement",
      pdf: multiPdf,
      signers: [{ name: "Ada" }, { name: "Grace" }],
    });
    const [tokens] = [req.signers.map((s) => s.signToken)];

    const first = await signByToken(
      db,
      serviceSigner,
      tokens[0] as string,
      "Ada",
    );
    expect(first.ok).toBe(true);
    expect(first.completed).toBe(false);

    const second = await signByToken(
      db,
      serviceSigner,
      tokens[1] as string,
      "Grace",
    );
    expect(second.ok).toBe(true);
    expect(second.completed).toBe(true);

    const signed = await getSignedPdf(db, req.id, req.manageToken);
    expect(signed).not.toBeNull();
  });

  test("defaults to the first signer when no signatures are detected", async () => {
    const req = await createMultiSignerRequest(db, {
      name: "No anchors",
      pdf,
      signers: [{ name: "Ada" }, { name: "Grace" }],
    });
    expect(req.signers).toHaveLength(2);
    const status = await getStatus(db, req.id, req.manageToken);
    expect(status?.status).toBe("sent");
  });
});

describe("drafts (save, send, delete) for an owner", () => {
  test("saving a draft does not send it; the owner can send it later", async () => {
    const req = await createMultiSignerRequest(db, {
      name: "Draft Agreement",
      pdf,
      signers: [{ name: "Ada", email: "ada@example.com" }],
      ownerId: "owner-1",
      draft: true,
    });
    const before = await getStatus(db, req.id, req.manageToken);
    expect(before?.status).toBe("draft");

    // a different owner cannot send it
    expect(await sendOwnedDraft(db, req.id, "intruder", [])).toBeNull();

    const sent = await sendOwnedDraft(db, req.id, "owner-1", []);
    expect(sent).not.toBeNull();
    expect(sent?.signers).toHaveLength(1);
    const after = await getStatus(db, req.id, req.manageToken);
    expect(after?.status).toBe("sent");
  });

  test("the owner can delete their document, others cannot", async () => {
    const req = await createMultiSignerRequest(db, {
      name: "Disposable",
      pdf,
      signers: [{ name: "Ada" }],
      ownerId: "owner-1",
      draft: true,
    });
    expect(await deleteOwnedDocument(db, req.id, "intruder", [])).toBe(false);
    expect(await deleteOwnedDocument(db, req.id, "owner-1", [])).toBe(true);
    expect(await getStatus(db, req.id, req.manageToken)).toBeNull();
  });
});

describe("document signing lifecycle", () => {
  test("creates a signing request with capability tokens", async () => {
    const req = await newRequest();
    expect(req.id).toBeTruthy();
    expect(req.manageToken).toBeTruthy();
    expect(req.signToken).toBeTruthy();
    expect(req.signToken).not.toBe(req.manageToken);
  });

  test("signer view marks the document viewed", async () => {
    const req = await newRequest();
    const view = await getSignerView(db, req.signToken);
    expect(view?.signerName).toBe("Ada Lovelace");
    expect(view?.signerStatus).toBe("pending");

    const status = await getStatus(db, req.id, req.manageToken);
    expect(status?.signers[0]?.status).toBe("viewed");
  });

  test("signing produces a valid signed PDF and completes the document", async () => {
    const req = await newRequest();
    const result = await signByToken(db, serviceSigner, req.signToken);
    expect(result.ok).toBe(true);

    const status = await getStatus(db, req.id, req.manageToken);
    expect(status?.status).toBe("completed");
    expect(status?.signers[0]?.status).toBe("signed");
    expect(status?.provenanceValid).toBe(true);

    const signed = await getSignedPdf(db, req.id, req.manageToken);
    expect(signed).not.toBeNull();
    const info = inspectPdfSignature(signed as Uint8Array);
    expect(info.hasSignature).toBe(true);
    expect(info.signerCommonName).toBe("Signet");
  });

  test("a document cannot be signed twice", async () => {
    const req = await newRequest();
    await signByToken(db, serviceSigner, req.signToken);
    const second = await signByToken(db, serviceSigner, req.signToken);
    expect(second.ok).toBe(false);
    expect(second.error).toBe("already_signed");
  });

  test("the wrong manage token reveals nothing", async () => {
    const req = await newRequest();
    const status = await getStatus(db, req.id, "wrong-token");
    expect(status).toBeNull();
    const signed = await getSignedPdf(db, req.id, "wrong-token");
    expect(signed).toBeNull();
  });

  test("a voided document cannot be signed", async () => {
    const req = await newRequest();
    expect(await voidDocument(db, req.id, req.manageToken)).toBe(true);
    const result = await signByToken(db, serviceSigner, req.signToken);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("voided");
  });

  test("provenance records the full lifecycle and verifies", async () => {
    const req = await newRequest();
    await getSignerView(db, req.signToken);
    await signByToken(db, serviceSigner, req.signToken);
    const status = await getStatus(db, req.id, req.manageToken);
    expect(status?.provenanceValid).toBe(true);
  });
});
