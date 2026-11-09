import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { document, signatureEvent, signer } from "../db/schema.ts";
import { generateToken } from "../db/tokens.ts";
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

  await appendProvenance(db, doc.id, {
    type: "document.created",
    data: { name: input.name, contentHash, signer: input.signerName },
  });

  return { id: doc.id, manageToken, signToken };
};

export interface SignerView {
  documentId: string;
  documentName: string;
  documentStatus: string;
  signerName: string;
  signerStatus: string;
}

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

  return row;
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

  const original = fromBase64(doc.originalPdf);
  const signed = await signPdf(original, serviceSigner.pkcs12, {
    name: sgn.name,
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
    data: { signer: sgn.name, contentHash: doc.contentHash },
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
