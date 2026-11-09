import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { document, field, signatureEvent, signer } from "../db/schema.ts";
import { generateToken } from "../db/tokens.ts";
import { detectFields } from "../fields/detect.ts";
import { stampFields } from "../fields/stamp.ts";
import type { ProvenanceEvent } from "../provenance/ledger.ts";
import { appendEvent, verifyLedger } from "../provenance/ledger.ts";
import { signPdf } from "../signing/pdfSigner.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");
const fromBase64 = (b64: string): Uint8Array =>
  Uint8Array.from(Buffer.from(b64, "base64"));

/**
 * Append a provenance event to a document's chain and persist it.
 *
 * The existing events are loaded, the new event is linked to the last hash, and
 * the row is written with the exact timestamp that was hashed so verification
 * reproduces the chain
 */
const appendProvenance = async (
  db: Db,
  documentId: string,
  input: { type: string; data: Record<string, unknown> },
): Promise<void> => {
  const rows = await db
    .select()
    .from(signatureEvent)
    .where(eq(signatureEvent.documentId, documentId))
    .orderBy(asc(signatureEvent.index));

  const chain: ProvenanceEvent[] = rows.map((r) => ({
    index: r.index,
    timestamp: r.createdAt.toISOString(),
    type: r.type,
    data: r.data as Record<string, unknown>,
    prevHash: r.prevHash,
    hash: r.hash,
  }));

  const timestamp = new Date().toISOString();
  const next = appendEvent(chain, { ...input, timestamp }).at(-1);
  if (!next) return;

  await db.insert(signatureEvent).values({
    documentId,
    index: next.index,
    type: next.type,
    data: next.data,
    prevHash: next.prevHash,
    hash: next.hash,
    createdAt: new Date(timestamp),
  });
};

export interface CreateSigningRequestInput {
  name: string;
  pdf: Uint8Array;
  signerName: string;
  signerEmail?: string;
  /** Gatekeeper subject of the signed-in sender, omitted for anonymous sends */
  ownerId?: string;
  ownerEmail?: string;
}

export interface SigningRequest {
  id: string;
  manageToken: string;
  signToken: string;
}

/** Create a document and a signing request for a single signer */
export const createSigningRequest = async (
  db: Db,
  input: CreateSigningRequestInput,
): Promise<SigningRequest> => {
  const manageToken = generateToken();
  const signToken = generateToken();
  const contentHash = sha256(input.pdf);

  const [doc] = await db
    .insert(document)
    .values({
      name: input.name,
      status: "sent",
      contentHash,
      originalPdf: toBase64(input.pdf),
      manageToken,
      ownerId: input.ownerId ?? null,
      ownerEmail: input.ownerEmail ?? null,
    })
    .returning({ id: document.id });

  if (!doc) throw new Error("failed to create document");

  await db.insert(signer).values({
    documentId: doc.id,
    name: input.signerName,
    email: input.signerEmail ?? null,
    signToken,
    status: "pending",
    orderIndex: 0,
  });

  // Auto-detect signature/date/initials fields from the document text. Best
  // effort: a document with no detectable anchors still signs
  const detected = await detectFields(input.pdf);
  if (detected.length > 0) {
    await db.insert(field).values(
      detected.map((f) => ({
        documentId: doc.id,
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        source: "detected",
      })),
    );
  }

  await appendProvenance(db, doc.id, {
    type: "document.created",
    data: {
      name: input.name,
      contentHash,
      signer: input.signerName,
      fields: detected.length,
    },
  });

  return { id: doc.id, manageToken, signToken };
};

export interface SignerView {
  documentId: string;
  documentName: string;
  documentStatus: string;
  signerName: string;
  signerStatus: string;
  fields: { signature: number; date: number; initials: number };
}

/** Count a document's fields by type, for the signer-facing summary */
const countFields = async (
  db: Db,
  documentId: string,
): Promise<{ signature: number; date: number; initials: number }> => {
  const rows = await db
    .select({ type: field.type })
    .from(field)
    .where(eq(field.documentId, documentId));
  const counts = { signature: 0, date: 0, initials: 0 };
  for (const row of rows) {
    if (row.type === "signature") counts.signature += 1;
    else if (row.type === "date") counts.date += 1;
    else if (row.type === "initials") counts.initials += 1;
  }
  return counts;
};

/** Load the signer-facing view for a sign token, recording a view event once */
export const getSignerView = async (
  db: Db,
  signToken: string,
): Promise<SignerView | null> => {
  const [row] = await db
    .select({
      documentId: document.id,
      documentName: document.name,
      documentStatus: document.status,
      signerName: signer.name,
      signerStatus: signer.status,
    })
    .from(signer)
    .innerJoin(document, eq(signer.documentId, document.id))
    .where(eq(signer.signToken, signToken));

  if (!row) return null;

  if (row.signerStatus === "pending") {
    await db
      .update(signer)
      .set({ status: "viewed" })
      .where(eq(signer.signToken, signToken));
    await appendProvenance(db, row.documentId, {
      type: "document.viewed",
      data: { signer: row.signerName },
    });
  }

  return { ...row, fields: await countFields(db, row.documentId) };
};

export interface SignResult {
  ok: boolean;
  documentId?: string;
  error?: string;
}

/** Apply the signature for a sign token and mark the document completed */
export const signByToken = async (
  db: Db,
  serviceSigner: ServiceSigner,
  signToken: string,
  signatureName?: string,
): Promise<SignResult> => {
  const [sgn] = await db
    .select()
    .from(signer)
    .where(eq(signer.signToken, signToken));
  if (!sgn) return { ok: false, error: "not_found" };
  if (sgn.status === "signed") return { ok: false, error: "already_signed" };

  const [doc] = await db
    .select()
    .from(document)
    .where(eq(document.id, sgn.documentId));
  if (!doc) return { ok: false, error: "not_found" };
  if (doc.status === "voided") return { ok: false, error: "voided" };

  const adopted = signatureName?.trim() || sgn.name;
  const dateStamp = new Date().toISOString().slice(0, 10);

  // Stamp the adopted signature and date into the detected fields, then apply
  // the cryptographic signature over the stamped document
  const fields = await db
    .select()
    .from(field)
    .where(eq(field.documentId, doc.id));
  const original = fromBase64(doc.originalPdf);
  const stamped = await stampFields(original, fields, {
    signature: adopted,
    date: dateStamp,
  });
  const signed = await signPdf(stamped, serviceSigner.pkcs12, {
    name: adopted,
    reason: "Signed via Signet",
    passphrase: serviceSigner.passphrase,
  });

  await db
    .update(signer)
    .set({ status: "signed", signedAt: new Date() })
    .where(eq(signer.id, sgn.id));

  await db
    .update(document)
    .set({
      signedPdf: toBase64(signed),
      status: "completed",
      updatedAt: new Date(),
    })
    .where(eq(document.id, doc.id));

  await appendProvenance(db, doc.id, {
    type: "document.signed",
    data: {
      signer: adopted,
      contentHash: doc.contentHash,
      fields: fields.length,
    },
  });

  return { ok: true, documentId: doc.id };
};

export interface DocumentStatus {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  signers: { name: string; email: string | null; status: string }[];
  provenanceValid: boolean;
}

/** Load status for a manage token, including signer states and ledger integrity */
export const getStatus = async (
  db: Db,
  id: string,
  manageToken: string,
): Promise<DocumentStatus | null> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), eq(document.manageToken, manageToken)));
  if (!doc) return null;

  const signers = await db
    .select()
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));

  const events = await db
    .select()
    .from(signatureEvent)
    .where(eq(signatureEvent.documentId, id))
    .orderBy(asc(signatureEvent.index));

  const chain: ProvenanceEvent[] = events.map((r) => ({
    index: r.index,
    timestamp: r.createdAt.toISOString(),
    type: r.type,
    data: r.data as Record<string, unknown>,
    prevHash: r.prevHash,
    hash: r.hash,
  }));

  return {
    id: doc.id,
    name: doc.name,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    signers: signers.map((s) => ({
      name: s.name,
      email: s.email,
      status: s.status,
    })),
    provenanceValid: verifyLedger(chain).valid,
  };
};

/** Return the signed PDF for a manage token, or null if not signed or wrong token */
export const getSignedPdf = async (
  db: Db,
  id: string,
  manageToken: string,
): Promise<Uint8Array | null> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), eq(document.manageToken, manageToken)));
  if (!doc?.signedPdf) return null;
  return fromBase64(doc.signedPdf);
};

/** Return the signed PDF for a signer's own sign token, or null if not signed */
export const getSignedPdfForSignToken = async (
  db: Db,
  signToken: string,
): Promise<Uint8Array | null> => {
  const [row] = await db
    .select({ signedPdf: document.signedPdf })
    .from(signer)
    .innerJoin(document, eq(signer.documentId, document.id))
    .where(eq(signer.signToken, signToken));
  if (!row?.signedPdf) return null;
  return fromBase64(row.signedPdf);
};

export interface OwnerDocument {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  manageToken: string;
  hasSignedPdf: boolean;
  signerName: string | null;
  signerStatus: string | null;
}

/**
 * List a signed-in owner's documents, newest first, for their dashboard. Each
 * row carries the owner's own manage token so the dashboard can link to the
 * status and signed-PDF routes.
 */
export const listDocumentsByOwner = async (
  db: Db,
  ownerId: string,
): Promise<OwnerDocument[]> => {
  const rows = await db
    .select({
      id: document.id,
      name: document.name,
      status: document.status,
      createdAt: document.createdAt,
      manageToken: document.manageToken,
      signedPdf: document.signedPdf,
      signerName: signer.name,
      signerStatus: signer.status,
    })
    .from(document)
    .leftJoin(signer, eq(signer.documentId, document.id))
    .where(eq(document.ownerId, ownerId))
    .orderBy(desc(document.createdAt));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    manageToken: r.manageToken,
    hasSignedPdf: r.signedPdf !== null,
    signerName: r.signerName,
    signerStatus: r.signerStatus,
  }));
};

/** Return the signed PDF for a document the given owner owns, else null */
export const getSignedPdfForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
): Promise<Uint8Array | null> => {
  const [doc] = await db
    .select({ signedPdf: document.signedPdf })
    .from(document)
    .where(and(eq(document.id, id), eq(document.ownerId, ownerId)));
  if (!doc?.signedPdf) return null;
  return fromBase64(doc.signedPdf);
};

/** Void a document so it can no longer be signed */
export const voidDocument = async (
  db: Db,
  id: string,
  manageToken: string,
): Promise<boolean> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), eq(document.manageToken, manageToken)));
  if (!doc) return false;

  await db
    .update(document)
    .set({ status: "voided", updatedAt: new Date() })
    .where(eq(document.id, id));
  await appendProvenance(db, id, { type: "document.voided", data: {} });
  return true;
};
