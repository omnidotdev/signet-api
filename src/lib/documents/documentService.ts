import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { document, field, signatureEvent, signer } from "../db/schema.ts";
import { generateToken } from "../db/tokens.ts";
import { detectFields } from "../fields/detect.ts";
import { initialsOf, stampFields } from "../fields/stamp.ts";
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

/** Distinct colors used to tint each signer's fields in the editor */
export const SIGNER_COLORS = [
  "#be6221",
  "#2563a6",
  "#2f855a",
  "#8a3ca3",
  "#b03a4a",
  "#0f766e",
];

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

  const [sgn] = await db
    .insert(signer)
    .values({
      documentId: doc.id,
      name: input.signerName,
      email: input.signerEmail ?? null,
      signToken,
      status: "pending",
      orderIndex: 0,
      color: SIGNER_COLORS[0],
    })
    .returning({ id: signer.id });
  if (!sgn) throw new Error("failed to create signer");

  // Auto-detect signature/date/initials fields from the document text and
  // assign them to the signer. Best effort: no anchors still signs
  const detected = await detectFields(input.pdf);
  if (detected.length > 0) {
    await db.insert(field).values(
      detected.map((f) => ({
        documentId: doc.id,
        signerId: sgn.id,
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

export interface DraftSignerInput {
  name: string;
  email?: string;
}

export interface CreateDraftInput {
  name: string;
  pdf: Uint8Array;
  ownerId?: string;
  ownerEmail?: string;
  signers: DraftSignerInput[];
}

export interface DraftRequest {
  id: string;
  manageToken: string;
}

/**
 * Create a draft document with one or more signers, auto-detect fields, and
 * assign the detected fields to the first signer. The draft is edited and then
 * sent; nothing is emailed here.
 */
export const createDraft = async (
  db: Db,
  input: CreateDraftInput,
): Promise<DraftRequest> => {
  const manageToken = generateToken();
  const contentHash = sha256(input.pdf);

  const [doc] = await db
    .insert(document)
    .values({
      name: input.name,
      status: "draft",
      contentHash,
      originalPdf: toBase64(input.pdf),
      manageToken,
      ownerId: input.ownerId ?? null,
      ownerEmail: input.ownerEmail ?? null,
    })
    .returning({ id: document.id });
  if (!doc) throw new Error("failed to create document");

  const signerRows = await db
    .insert(signer)
    .values(
      input.signers.map((s, i) => ({
        documentId: doc.id,
        name: s.name,
        email: s.email ?? null,
        signToken: generateToken(),
        status: "pending",
        orderIndex: i,
        color: SIGNER_COLORS[i % SIGNER_COLORS.length],
      })),
    )
    .returning({ id: signer.id });

  const firstSigner = signerRows[0];
  const detected = await detectFields(input.pdf);
  if (detected.length > 0 && firstSigner) {
    await db.insert(field).values(
      detected.map((f) => ({
        documentId: doc.id,
        signerId: firstSigner.id,
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
      signers: input.signers.length,
      fields: detected.length,
    },
  });

  return { id: doc.id, manageToken };
};

export interface EditorField {
  id?: string;
  signerId: string | null;
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditorData {
  id: string;
  name: string;
  status: string;
  pdfBase64: string;
  signers: {
    id: string;
    name: string;
    email: string | null;
    color: string | null;
    status: string;
    orderIndex: number;
  }[];
  fields: EditorField[];
}

/** Load everything the editor needs, gated by the manage token */
export const getEditorData = async (
  db: Db,
  id: string,
  manageToken: string,
): Promise<EditorData | null> => {
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
  const fields = await db.select().from(field).where(eq(field.documentId, id));

  return {
    id: doc.id,
    name: doc.name,
    status: doc.status,
    pdfBase64: doc.originalPdf,
    signers: signers.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      color: s.color,
      status: s.status,
      orderIndex: s.orderIndex,
    })),
    fields: fields.map((f) => ({
      id: f.id,
      signerId: f.signerId,
      type: f.type,
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
    })),
  };
};

/** Replace a draft's fields with the editor's set, gated by the manage token */
export const saveFields = async (
  db: Db,
  id: string,
  manageToken: string,
  fields: EditorField[],
): Promise<boolean> => {
  const [doc] = await db
    .select({ status: document.status })
    .from(document)
    .where(and(eq(document.id, id), eq(document.manageToken, manageToken)));
  if (!doc || doc.status !== "draft") return false;

  const signerRows = await db
    .select({ id: signer.id })
    .from(signer)
    .where(eq(signer.documentId, id));
  const validSigners = new Set(signerRows.map((s) => s.id));

  await db.delete(field).where(eq(field.documentId, id));
  if (fields.length > 0) {
    await db.insert(field).values(
      fields.map((f) => ({
        documentId: id,
        signerId:
          f.signerId && validSigners.has(f.signerId) ? f.signerId : null,
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        source: "manual",
      })),
    );
  }
  return true;
};

export interface SendResult {
  signers: {
    name: string;
    email: string | null;
    signToken: string;
  }[];
}

/** Send a draft: mark it sent and return the signer links to deliver */
export const sendDraft = async (
  db: Db,
  id: string,
  manageToken: string,
): Promise<SendResult | null> => {
  const [doc] = await db
    .select({ status: document.status })
    .from(document)
    .where(and(eq(document.id, id), eq(document.manageToken, manageToken)));
  if (!doc || doc.status !== "draft") return null;

  await db
    .update(document)
    .set({ status: "sent", updatedAt: new Date() })
    .where(eq(document.id, id));
  await appendProvenance(db, id, { type: "document.sent", data: {} });

  const signers = await db
    .select({
      name: signer.name,
      email: signer.email,
      signToken: signer.signToken,
    })
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));
  return { signers };
};

export interface SignerView {
  documentId: string;
  documentName: string;
  documentStatus: string;
  signerName: string;
  signerStatus: string;
  fields: { signature: number; date: number; initials: number };
}

/** Count one signer's fields by type, for the signer-facing summary */
const countFields = async (
  db: Db,
  signerId: string,
): Promise<{ signature: number; date: number; initials: number }> => {
  const rows = await db
    .select({ type: field.type })
    .from(field)
    .where(eq(field.signerId, signerId));
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
      signerId: signer.id,
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

  const { signerId, ...view } = row;
  return { ...view, fields: await countFields(db, signerId) };
};

export interface SignerFillField {
  id: string;
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SignerFillData {
  documentName: string;
  signerName: string;
  alreadySigned: boolean;
  pdfBase64: string;
  fields: SignerFillField[];
}

/**
 * Everything the signer's fill overlay needs: the document, this signer's
 * fields, and the PDF. Records a view event the first time, like getSignerView.
 */
export const getSignerFillData = async (
  db: Db,
  signToken: string,
): Promise<SignerFillData | null> => {
  const [row] = await db
    .select({
      documentId: document.id,
      documentName: document.name,
      documentStatus: document.status,
      originalPdf: document.originalPdf,
      signerId: signer.id,
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

  const fields = await db
    .select({
      id: field.id,
      type: field.type,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
    })
    .from(field)
    .where(eq(field.signerId, row.signerId));

  return {
    documentName: row.documentName,
    signerName: row.signerName,
    alreadySigned:
      row.documentStatus === "completed" || row.signerStatus === "signed",
    pdfBase64: row.originalPdf,
    fields,
  };
};

export interface SignResult {
  ok: boolean;
  documentId?: string;
  /** true when this signature completed the document (all signers done) */
  completed?: boolean;
  error?: string;
}

/** The text a field shows for an adopted signature and date */
const fieldValueFor = (type: string, adopted: string, date: string): string => {
  if (type === "signature") return adopted;
  if (type === "initials") return initialsOf(adopted);
  if (type === "date") return date;
  return "";
};

/**
 * Record a signer's signature: fill their fields with the adopted signature and
 * date, mark them signed, and once every signer has signed, stamp all the
 * filled fields and apply the single cryptographic seal.
 */
export interface SignOptions {
  /** base64 PNG of a drawn signature, stamped into signature/initials fields */
  signatureImage?: string | null;
  /** per-field text the signer typed, keyed by field id */
  textValues?: Record<string, string>;
}

export const signByToken = async (
  db: Db,
  serviceSigner: ServiceSigner,
  signToken: string,
  signatureName?: string,
  options?: SignOptions,
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
  if (doc.status === "draft") return { ok: false, error: "not_sent" };

  const adopted = signatureName?.trim() || sgn.name;
  const dateStamp = new Date().toISOString().slice(0, 10);

  // fill this signer's fields: typed text where provided, else derived values
  const myFields = await db
    .select()
    .from(field)
    .where(and(eq(field.documentId, doc.id), eq(field.signerId, sgn.id)));
  for (const f of myFields) {
    const typed = options?.textValues?.[f.id];
    const value =
      f.type === "text"
        ? (typed ?? f.value ?? "")
        : fieldValueFor(f.type, adopted, dateStamp);
    await db.update(field).set({ value }).where(eq(field.id, f.id));
  }

  await db
    .update(signer)
    .set({
      status: "signed",
      signedAt: new Date(),
      signatureImage: options?.signatureImage ?? null,
    })
    .where(eq(signer.id, sgn.id));
  await appendProvenance(db, doc.id, {
    type: "document.signed",
    data: {
      signer: adopted,
      contentHash: doc.contentHash,
      fields: myFields.length,
    },
  });

  // seal once every signer has signed
  const signers = await db
    .select()
    .from(signer)
    .where(eq(signer.documentId, doc.id));
  const completed = signers.every((s) => s.status === "signed");
  if (completed) {
    const allFields = await db
      .select()
      .from(field)
      .where(eq(field.documentId, doc.id));
    // a signature/initials field uses its signer's drawn image when they drew one
    const imageBySigner = new Map(signers.map((s) => [s.id, s.signatureImage]));
    const items = allFields.map((f) => {
      const drawn =
        (f.type === "signature" || f.type === "initials") && f.signerId
          ? imageBySigner.get(f.signerId)
          : null;
      return {
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        value: f.value,
        image: drawn ? fromBase64(drawn) : null,
      };
    });
    const stamped = await stampFields(fromBase64(doc.originalPdf), items);
    const signed = await signPdf(stamped, serviceSigner.pkcs12, {
      name: serviceSigner.commonName,
      reason: "Signed via Signet",
      passphrase: serviceSigner.passphrase,
    });
    await db
      .update(document)
      .set({
        signedPdf: toBase64(signed),
        status: "completed",
        updatedAt: new Date(),
      })
      .where(eq(document.id, doc.id));
    await appendProvenance(db, doc.id, {
      type: "document.completed",
      data: { signers: signers.length },
    });
  }

  return { ok: true, documentId: doc.id, completed };
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
