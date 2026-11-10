import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { TemplateField } from "../db/schema.ts";
import { document, field, signatureEvent, signer } from "../db/schema.ts";
import { generateToken } from "../db/tokens.ts";
import {
  emitDocumentCompleted,
  emitDocumentCreated,
  emitDocumentSent,
  emitDocumentVoided,
  emitSignatureCompleted,
} from "../events/signetEvents.ts";
import type { DetectedField } from "../fields/detect.ts";
import { detectFields } from "../fields/detect.ts";
import { initialsOf, stampFields } from "../fields/stamp.ts";
import type { ProvenanceEvent } from "../provenance/ledger.ts";
import { appendEvent, verifyLedger } from "../provenance/ledger.ts";
import { requestTimestamp } from "../provenance/timestamp.ts";
import { signPdf } from "../signing/pdfSigner.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import {
  deletePdf,
  loadPdf,
  originalKey,
  signedKey,
  storePdf,
} from "../storage/pdfStore.ts";

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
  /** workspace (organization) the document belongs to */
  organizationId?: string;
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
  const id = randomUUID();
  const manageToken = generateToken();
  const signToken = generateToken();
  const contentHash = sha256(input.pdf);
  const storedOriginal = await storePdf(originalKey(id), input.pdf);

  const [doc] = await db
    .insert(document)
    .values({
      id,
      name: input.name,
      status: "sent",
      contentHash,
      originalPdf: storedOriginal.inline,
      originalPdfKey: storedOriginal.key,
      manageToken,
      ownerId: input.ownerId ?? null,
      organizationId: input.organizationId ?? null,
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

  // a single-signer request is created and sent in one step
  const ownerId = input.ownerId ?? null;
  emitDocumentCreated({
    documentId: doc.id,
    name: input.name,
    ownerId,
    signerCount: 1,
    signingMode: "parallel",
    fieldCount: detected.length,
  });
  emitDocumentSent({
    documentId: doc.id,
    name: input.name,
    ownerId,
    signerCount: 1,
    signingMode: "parallel",
  });

  return { id: doc.id, manageToken, signToken };
};

export interface DraftSignerInput {
  name: string;
  email?: string;
}

export interface MultiSignerRequestInput {
  name: string;
  pdf: Uint8Array;
  signers: DraftSignerInput[];
  /** "sequential" to require signing in order, else "parallel" (any order) */
  signingMode?: "parallel" | "sequential";
  /** Gatekeeper subject of the signed-in sender, omitted for anonymous sends */
  ownerId?: string;
  ownerEmail?: string;
  /** workspace (organization) the document belongs to */
  organizationId?: string;
  /** save as an unsent draft (status "draft") instead of sending now */
  draft?: boolean;
}

export interface MultiSignerRequest {
  id: string;
  manageToken: string;
  signers: {
    name: string;
    email: string | null;
    signToken: string;
    orderIndex: number;
  }[];
}

/**
 * Assign detected fields to signers for an unattended multi-signer send (no
 * field editor). Signature and initials fields are handed out top-to-bottom,
 * round-robin across the signers, so each party gets their own signing line in
 * a standard multi-party block. A date or text field is paired to the nearest
 * signature on its page (so a party's date fills when they sign), else to the
 * first signer. Returns the signer index for each detected field.
 */
const autoAssignSigners = (
  fields: DetectedField[],
  signerCount: number,
): number[] => {
  const sigOrder = fields
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.type === "signature" || f.type === "initials")
    .sort((a, b) => a.f.page - b.f.page || b.f.y - a.f.y);
  const indexToSigner = new Map<number, number>();
  sigOrder.forEach(({ i }, rank) => {
    indexToSigner.set(i, rank % signerCount);
  });
  return fields.map((f, i) => {
    const direct = indexToSigner.get(i);
    if (direct !== undefined) return direct;
    // nearest signature on the same page
    let best: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const { f: s, i: si } of sigOrder) {
      if (s.page !== f.page) continue;
      const d = Math.abs(s.y - f.y);
      if (d < bestDist) {
        bestDist = d;
        best = indexToSigner.get(si) ?? 0;
      }
    }
    return best ?? 0;
  });
};

/**
 * Create and immediately send a document to one or more signers, auto-detecting
 * fields and assigning each party their own signing line. Unlike createDraft,
 * this skips the field editor (nothing is placed by hand), so a sender can send
 * a standard multi-party document straight from the upload surface.
 */
export const createMultiSignerRequest = async (
  db: Db,
  input: MultiSignerRequestInput,
): Promise<MultiSignerRequest> => {
  const id = randomUUID();
  const manageToken = generateToken();
  const contentHash = sha256(input.pdf);
  const storedOriginal = await storePdf(originalKey(id), input.pdf);
  const signingMode =
    input.signingMode === "sequential" ? "sequential" : "parallel";
  const isDraft = input.draft === true;

  const [doc] = await db
    .insert(document)
    .values({
      id,
      name: input.name,
      status: isDraft ? "draft" : "sent",
      contentHash,
      originalPdf: storedOriginal.inline,
      originalPdfKey: storedOriginal.key,
      manageToken,
      signingMode,
      ownerId: input.ownerId ?? null,
      organizationId: input.organizationId ?? null,
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
    .returning({
      id: signer.id,
      name: signer.name,
      email: signer.email,
      signToken: signer.signToken,
      orderIndex: signer.orderIndex,
    });

  const detected = await detectFields(input.pdf);
  if (detected.length > 0) {
    const assignment = autoAssignSigners(detected, signerRows.length);
    await db.insert(field).values(
      detected.map((f, i) => ({
        documentId: doc.id,
        signerId: signerRows[assignment[i] ?? 0]?.id ?? signerRows[0]?.id,
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

  const ownerId = input.ownerId ?? null;
  emitDocumentCreated({
    documentId: doc.id,
    name: input.name,
    ownerId,
    signerCount: input.signers.length,
    signingMode,
    fieldCount: detected.length,
  });
  // a draft is saved but not sent; it emits document.sent only when sent later
  if (!isDraft) {
    await db
      .update(document)
      .set({ sentAt: new Date() })
      .where(eq(document.id, doc.id));
    emitDocumentSent({
      documentId: doc.id,
      name: input.name,
      ownerId,
      signerCount: input.signers.length,
      signingMode,
    });
  }

  return {
    id: doc.id,
    manageToken,
    signers: signerRows.map((s) => ({
      name: s.name,
      email: s.email,
      signToken: s.signToken,
      orderIndex: s.orderIndex,
    })),
  };
};

/**
 * Send a draft the owner owns (or shares through a workspace): flip it to sent,
 * stamp sentAt, and return each signer so the caller can email them. Null when
 * the document is not a draft the owner may send.
 */
export const sendOwnedDraft = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
): Promise<SendResult | null> => {
  const access = [eq(document.ownerId, ownerId)];
  if (workspaceIds.length > 0) {
    access.push(inArray(document.organizationId, workspaceIds));
  }
  const [doc] = await db
    .select({
      status: document.status,
      signingMode: document.signingMode,
      name: document.name,
      ownerId: document.ownerId,
    })
    .from(document)
    .where(and(eq(document.id, id), or(...access)));
  if (!doc || doc.status !== "draft") return null;

  const now = new Date();
  await db
    .update(document)
    .set({ status: "sent", sentAt: now, updatedAt: now })
    .where(eq(document.id, id));
  await appendProvenance(db, id, { type: "document.sent", data: {} });

  const rows = await db
    .select({
      name: signer.name,
      email: signer.email,
      signToken: signer.signToken,
      orderIndex: signer.orderIndex,
    })
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));
  const signers = rows.map((s) => ({
    name: s.name,
    email: s.email,
    signToken: s.signToken,
    active:
      doc.signingMode !== "sequential" || s.orderIndex === rows[0]?.orderIndex,
  }));

  emitDocumentSent({
    documentId: id,
    name: doc.name,
    ownerId: doc.ownerId,
    signerCount: rows.length,
    signingMode: doc.signingMode,
  });

  return { documentName: doc.name, signers };
};

/**
 * Rename a document the owner owns (or shares through a workspace). Returns the
 * new name on success, or null when the owner may not rename it or the name is
 * empty.
 */
export const renameOwnedDocument = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
  name: string,
): Promise<string | null> => {
  const trimmed = name.trim().slice(0, 200);
  if (!trimmed) return null;
  const access = [eq(document.ownerId, ownerId)];
  if (workspaceIds.length > 0) {
    access.push(inArray(document.organizationId, workspaceIds));
  }
  const updated = await db
    .update(document)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(and(eq(document.id, id), or(...access)))
    .returning({ id: document.id });
  return updated.length > 0 ? trimmed : null;
};

/**
 * Permanently delete a document the owner owns (or shares through a workspace),
 * with its signers, fields, provenance, and stored PDFs. Returns true on
 * delete, false when the owner may not delete it.
 */
export const deleteOwnedDocument = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
): Promise<boolean> => {
  const access = [eq(document.ownerId, ownerId)];
  if (workspaceIds.length > 0) {
    access.push(inArray(document.organizationId, workspaceIds));
  }
  const [doc] = await db
    .select({
      id: document.id,
      originalPdfKey: document.originalPdfKey,
      signedPdfKey: document.signedPdfKey,
    })
    .from(document)
    .where(and(eq(document.id, id), or(...access)));
  if (!doc) return false;

  await db.delete(signatureEvent).where(eq(signatureEvent.documentId, id));
  await db.delete(field).where(eq(field.documentId, id));
  await db.delete(signer).where(eq(signer.documentId, id));
  await db.delete(document).where(eq(document.id, id));

  for (const key of [doc.originalPdfKey, doc.signedPdfKey]) {
    if (key) await deletePdf(key).catch(() => {});
  }
  return true;
};

export interface CreateDraftInput {
  name: string;
  pdf: Uint8Array;
  ownerId?: string;
  ownerEmail?: string;
  signers: DraftSignerInput[];
  /** "sequential" to require signing in order, else "parallel" (any order) */
  signingMode?: "parallel" | "sequential";
  /** pre-set fields (from a template); when omitted, fields are auto-detected */
  fields?: TemplateField[];
  /** workspace (organization) the document belongs to */
  organizationId?: string;
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
  const id = randomUUID();
  const manageToken = generateToken();
  const contentHash = sha256(input.pdf);
  const storedOriginal = await storePdf(originalKey(id), input.pdf);

  const [doc] = await db
    .insert(document)
    .values({
      id,
      name: input.name,
      status: "draft",
      contentHash,
      originalPdf: storedOriginal.inline,
      originalPdfKey: storedOriginal.key,
      manageToken,
      signingMode:
        input.signingMode === "sequential" ? "sequential" : "parallel",
      ownerId: input.ownerId ?? null,
      organizationId: input.organizationId ?? null,
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
  // use the template's fields when provided, else auto-detect from the text
  const fromTemplate = input.fields !== undefined;
  const placed = input.fields ?? (await detectFields(input.pdf));
  if (placed.length > 0 && firstSigner) {
    await db.insert(field).values(
      placed.map((f) => ({
        documentId: doc.id,
        signerId: firstSigner.id,
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        source: fromTemplate ? "template" : "detected",
      })),
    );
  }

  await appendProvenance(db, doc.id, {
    type: "document.created",
    data: {
      name: input.name,
      contentHash,
      signers: input.signers.length,
      fields: placed.length,
    },
  });

  // a draft is created but not yet sent (see sendDraft)
  emitDocumentCreated({
    documentId: doc.id,
    name: input.name,
    ownerId: input.ownerId ?? null,
    signerCount: input.signers.length,
    signingMode: input.signingMode ?? "parallel",
    fieldCount: placed.length,
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
  const pdfBase64 = toBase64(
    await loadPdf(doc.originalPdf, doc.originalPdfKey),
  );

  return {
    id: doc.id,
    name: doc.name,
    status: doc.status,
    pdfBase64,
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
  documentName: string;
  signers: {
    name: string;
    email: string | null;
    signToken: string;
    /** whether to email this signer now (false for a later sequential signer) */
    active: boolean;
  }[];
}

/** Send a draft: mark it sent and return the signer links to deliver */
export const sendDraft = async (
  db: Db,
  id: string,
  manageToken: string,
): Promise<SendResult | null> => {
  const [doc] = await db
    .select({
      status: document.status,
      signingMode: document.signingMode,
      name: document.name,
      ownerId: document.ownerId,
    })
    .from(document)
    .where(and(eq(document.id, id), eq(document.manageToken, manageToken)));
  if (!doc || doc.status !== "draft") return null;

  const now = new Date();
  await db
    .update(document)
    .set({ status: "sent", sentAt: now, updatedAt: now })
    .where(eq(document.id, id));
  await appendProvenance(db, id, { type: "document.sent", data: {} });

  const rows = await db
    .select({
      name: signer.name,
      email: signer.email,
      signToken: signer.signToken,
      orderIndex: signer.orderIndex,
    })
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));
  // in sequential mode only the first signer is active; in parallel, all are
  const signers = rows.map((s) => ({
    name: s.name,
    email: s.email,
    signToken: s.signToken,
    active:
      doc.signingMode !== "sequential" || s.orderIndex === rows[0]?.orderIndex,
  }));

  emitDocumentSent({
    documentId: id,
    name: doc.name,
    ownerId: doc.ownerId,
    signerCount: rows.length,
    signingMode: doc.signingMode,
  });

  return { documentName: doc.name, signers };
};

/**
 * Load a document by id + manage token only when it is still a draft. Signers
 * can be changed only before sending; once sent, the signer set is locked so a
 * signature in progress can never be invalidated by a roster change.
 */
const loadDraftForManage = async (
  db: Db,
  id: string,
  manageToken: string,
): Promise<{ id: string; status: string } | null> => {
  const [doc] = await db
    .select({ id: document.id, status: document.status })
    .from(document)
    .where(and(eq(document.id, id), eq(document.manageToken, manageToken)));
  if (!doc || doc.status !== "draft") return null;
  return doc;
};

export interface AddedSigner {
  id: string;
  name: string;
  email: string | null;
  color: string;
  signToken: string;
}

/** Add a signer to a draft (draft only). Returns the new signer, or null */
export const addSignerToDraft = async (
  db: Db,
  id: string,
  manageToken: string,
  input: DraftSignerInput,
): Promise<AddedSigner | null> => {
  const doc = await loadDraftForManage(db, id, manageToken);
  if (!doc) return null;
  const name = input.name?.trim();
  if (!name) return null;

  const existing = await db
    .select({ orderIndex: signer.orderIndex })
    .from(signer)
    .where(eq(signer.documentId, id));
  const nextOrder =
    existing.reduce((max, s) => Math.max(max, s.orderIndex), -1) + 1;

  const [row] = await db
    .insert(signer)
    .values({
      documentId: id,
      name,
      email: input.email?.trim() || null,
      signToken: generateToken(),
      status: "pending",
      orderIndex: nextOrder,
      color: SIGNER_COLORS[nextOrder % SIGNER_COLORS.length] ?? null,
    })
    .returning({
      id: signer.id,
      name: signer.name,
      email: signer.email,
      color: signer.color,
      signToken: signer.signToken,
    });
  if (!row) throw new Error("failed to add signer");
  await appendProvenance(db, id, {
    type: "signer.added",
    data: { signer: name },
  });
  return { ...row, color: row.color ?? "" };
};

/**
 * Remove a signer from a draft (draft only). Deletes the signer's fields (they
 * belonged to that person) and re-normalizes the remaining order. Refuses to
 * remove the last signer. Returns false when not a draft, unknown signer, or it
 * would leave zero signers.
 */
export const removeSignerFromDraft = async (
  db: Db,
  id: string,
  manageToken: string,
  signerId: string,
): Promise<boolean> => {
  const doc = await loadDraftForManage(db, id, manageToken);
  if (!doc) return false;

  const roster = await db
    .select({ id: signer.id, name: signer.name, orderIndex: signer.orderIndex })
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));
  const target = roster.find((s) => s.id === signerId);
  if (!target) return false;
  if (roster.length <= 1) return false; // a document needs at least one signer

  // the removed signer's fields are theirs, so they go with them
  await db
    .delete(field)
    .where(and(eq(field.documentId, id), eq(field.signerId, signerId)));
  await db.delete(signer).where(eq(signer.id, signerId));

  // re-number the remaining signers so order stays 0..n-1 (sequential routing)
  const remaining = roster.filter((s) => s.id !== signerId);
  for (let i = 0; i < remaining.length; i++) {
    const s = remaining[i];
    if (s && s.orderIndex !== i) {
      await db.update(signer).set({ orderIndex: i }).where(eq(signer.id, s.id));
    }
  }
  await appendProvenance(db, id, {
    type: "signer.removed",
    data: { signer: target.name },
  });
  return true;
};

/** Update a draft signer's name/email (draft only). Returns false if not found */
export const updateDraftSigner = async (
  db: Db,
  id: string,
  manageToken: string,
  signerId: string,
  input: { name?: string; email?: string | null },
): Promise<boolean> => {
  const doc = await loadDraftForManage(db, id, manageToken);
  if (!doc) return false;
  const [existing] = await db
    .select({ id: signer.id })
    .from(signer)
    .where(and(eq(signer.id, signerId), eq(signer.documentId, id)));
  if (!existing) return false;

  const patch: { name?: string; email?: string | null } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return false;
    patch.name = name;
  }
  if (input.email !== undefined) patch.email = input.email?.trim() || null;
  if (Object.keys(patch).length > 0) {
    await db.update(signer).set(patch).where(eq(signer.id, signerId));
  }
  return true;
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
  /** in sequential mode, the name of the signer who must sign first, else null */
  waitingFor: string | null;
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
      signingMode: document.signingMode,
      originalPdf: document.originalPdf,
      originalPdfKey: document.originalPdfKey,
      signerId: signer.id,
      signerName: signer.name,
      signerStatus: signer.status,
      orderIndex: signer.orderIndex,
    })
    .from(signer)
    .innerJoin(document, eq(signer.documentId, document.id))
    .where(eq(signer.signToken, signToken));
  if (!row) return null;

  // sequential routing: find any earlier-order signer who has not signed yet
  let waitingFor: string | null = null;
  if (row.signingMode === "sequential" && row.signerStatus !== "signed") {
    const [earlier] = await db
      .select({ name: signer.name })
      .from(signer)
      .where(
        and(
          eq(signer.documentId, row.documentId),
          lt(signer.orderIndex, row.orderIndex),
          ne(signer.status, "signed"),
        ),
      )
      .orderBy(asc(signer.orderIndex));
    waitingFor = earlier?.name ?? null;
  }

  // record a view only when it is this signer's turn
  if (row.signerStatus === "pending" && !waitingFor) {
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
  const pdfBase64 = toBase64(
    await loadPdf(row.originalPdf, row.originalPdfKey),
  );

  return {
    documentName: row.documentName,
    signerName: row.signerName,
    alreadySigned:
      row.documentStatus === "completed" || row.signerStatus === "signed",
    waitingFor,
    pdfBase64,
    fields,
  };
};

export interface SignResult {
  ok: boolean;
  documentId?: string;
  /** true when this signature completed the document (all signers done) */
  completed?: boolean;
  /** the next signer to notify now (sequential routing), if any */
  notifySigner?: {
    name: string;
    email: string | null;
    signToken: string;
    documentName: string;
  };
  /** present when this signature completed the document: who to notify */
  completion?: {
    documentName: string;
    ownerEmail: string | null;
    signers: { name: string; email: string | null; signToken: string }[];
  };
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

  // sequential routing: an earlier-order signer must go first
  if (doc.signingMode === "sequential") {
    const earlier = await db
      .select({ id: signer.id })
      .from(signer)
      .where(
        and(
          eq(signer.documentId, doc.id),
          lt(signer.orderIndex, sgn.orderIndex),
          ne(signer.status, "signed"),
        ),
      );
    if (earlier.length > 0) return { ok: false, error: "out_of_order" };
  }

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
  emitSignatureCompleted({
    documentId: doc.id,
    signerId: sgn.id,
    signerName: adopted,
    ownerId: doc.ownerId,
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
    const original = await loadPdf(doc.originalPdf, doc.originalPdfKey);
    const stamped = await stampFields(original, items);
    const signed = await signPdf(stamped, serviceSigner.pkcs12, {
      name: serviceSigner.commonName,
      reason: "Signed via Signet",
      passphrase: serviceSigner.passphrase,
    });
    const storedSigned = await storePdf(signedKey(doc.id), signed);
    await db
      .update(document)
      .set({
        signedPdf: storedSigned.inline,
        signedPdfKey: storedSigned.key,
        status: "completed",
        updatedAt: new Date(),
      })
      .where(eq(document.id, doc.id));
    // anchor the sealed document to a trusted time (best-effort: a TSA outage or
    // no SIGNET_TSA_URL still seals, just without a trusted timestamp)
    const timestamp = await requestTimestamp(signed);
    await appendProvenance(db, doc.id, {
      type: "document.completed",
      data: {
        signers: signers.length,
        ...(timestamp
          ? {
              timestamp: {
                token: timestamp.token,
                genTime: timestamp.genTime,
                tsa: timestamp.tsa,
              },
            }
          : {}),
      },
    });
    emitDocumentCompleted({
      documentId: doc.id,
      name: doc.name,
      ownerId: doc.ownerId,
      signerCount: signers.length,
    });
  }

  // sequential routing: hand off to the next signer in order
  let notifySigner: SignResult["notifySigner"];
  if (!completed && doc.signingMode === "sequential") {
    const next = signers
      .filter((s) => s.status !== "signed")
      .sort((a, b) => a.orderIndex - b.orderIndex)[0];
    if (next) {
      notifySigner = {
        name: next.name,
        email: next.email,
        signToken: next.signToken,
        documentName: doc.name,
      };
    }
  }

  // on completion, hand back who to tell the document is finished
  const completion: SignResult["completion"] = completed
    ? {
        documentName: doc.name,
        ownerEmail: doc.ownerEmail,
        signers: signers.map((s) => ({
          name: s.name,
          email: s.email,
          signToken: s.signToken,
        })),
      }
    : undefined;

  return { ok: true, documentId: doc.id, completed, notifySigner, completion };
};

export interface DocumentStatus {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  signers: { name: string; email: string | null; status: string }[];
  provenanceValid: boolean;
  /** the TSA-asserted trusted time the sealed document was timestamped, if any */
  trustedTimestamp: { genTime: string | null; tsa: string } | null;
}

/** Pull the trusted timestamp recorded on the document.completed event, if any */
const trustedTimestampFrom = (
  chain: ProvenanceEvent[],
): DocumentStatus["trustedTimestamp"] => {
  const completed = chain.find((e) => e.type === "document.completed");
  const ts = (
    completed?.data as { timestamp?: { genTime?: string; tsa?: string } }
  )?.timestamp;
  if (!ts?.tsa) return null;
  return { genTime: ts.genTime ?? null, tsa: ts.tsa };
};

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
    trustedTimestamp: trustedTimestampFrom(chain),
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
  if (!doc || (!doc.signedPdf && !doc.signedPdfKey)) return null;
  return loadPdf(doc.signedPdf ?? "", doc.signedPdfKey);
};

/** Return the signed PDF for a signer's own sign token, or null if not signed */
export const getSignedPdfForSignToken = async (
  db: Db,
  signToken: string,
): Promise<Uint8Array | null> => {
  const [row] = await db
    .select({
      signedPdf: document.signedPdf,
      signedPdfKey: document.signedPdfKey,
    })
    .from(signer)
    .innerJoin(document, eq(signer.documentId, document.id))
    .where(eq(signer.signToken, signToken));
  if (!row || (!row.signedPdf && !row.signedPdfKey)) return null;
  return loadPdf(row.signedPdf ?? "", row.signedPdfKey);
};

export interface OwnerDocument {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  manageToken: string;
  hasSignedPdf: boolean;
  /** the first signer's name, for a one-line summary */
  signerName: string | null;
  /** the first signer's status */
  signerStatus: string | null;
  /** total number of signers on the document */
  signerCount: number;
}

interface DocumentRow {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  manageToken: string;
  signedPdf: string | null;
  signedPdfKey: string | null;
}

const DOCUMENT_COLUMNS = {
  id: document.id,
  name: document.name,
  status: document.status,
  createdAt: document.createdAt,
  manageToken: document.manageToken,
  signedPdf: document.signedPdf,
  signedPdfKey: document.signedPdfKey,
};

/**
 * Turn document rows into OwnerDocuments, attaching each document's signers in
 * one extra query. Kept separate from the document query so a multi-signer
 * document is one row, not one row per signer (which duplicated the history).
 */
const toOwnerDocuments = async (
  db: Db,
  docRows: DocumentRow[],
): Promise<OwnerDocument[]> => {
  if (docRows.length === 0) return [];
  const ids = docRows.map((r) => r.id);
  const signerRows = await db
    .select({
      documentId: signer.documentId,
      name: signer.name,
      status: signer.status,
    })
    .from(signer)
    .where(inArray(signer.documentId, ids))
    .orderBy(asc(signer.orderIndex));

  const byDoc = new Map<string, { name: string; status: string }[]>();
  for (const s of signerRows) {
    const list = byDoc.get(s.documentId) ?? [];
    list.push({ name: s.name, status: s.status });
    byDoc.set(s.documentId, list);
  }

  return docRows.map((r) => {
    const signers = byDoc.get(r.id) ?? [];
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      manageToken: r.manageToken,
      hasSignedPdf: r.signedPdf !== null || r.signedPdfKey !== null,
      signerName: signers[0]?.name ?? null,
      signerStatus: signers[0]?.status ?? null,
      signerCount: signers.length,
    };
  });
};

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
    .select(DOCUMENT_COLUMNS)
    .from(document)
    .where(eq(document.ownerId, ownerId))
    .orderBy(desc(document.createdAt));
  return toOwnerDocuments(db, rows);
};

/**
 * List documents for a sender's dashboard, scoped to the active workspace. A
 * safe superset: the active workspace's documents (visible to every member)
 * plus anything the sender personally owns, so switching workspace never hides
 * a sender's own documents and workspace members see shared ones.
 */
export const listWorkspaceDocuments = async (
  db: Db,
  ownerId: string,
  organizationId: string | undefined,
): Promise<OwnerDocument[]> => {
  const scope = organizationId
    ? or(
        eq(document.organizationId, organizationId),
        eq(document.ownerId, ownerId),
      )
    : eq(document.ownerId, ownerId);
  const rows = await db
    .select(DOCUMENT_COLUMNS)
    .from(document)
    .where(scope)
    .orderBy(desc(document.createdAt));
  return toOwnerDocuments(db, rows);
};

/**
 * Return a signed document's bytes when the requester may access it: they own
 * it, or it belongs to one of their workspaces. Null otherwise or if unsigned.
 */
export const getSignedPdfForMember = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
): Promise<Uint8Array | null> => {
  const access = [eq(document.ownerId, ownerId)];
  if (workspaceIds.length > 0) {
    access.push(inArray(document.organizationId, workspaceIds));
  }
  const [doc] = await db
    .select({
      signedPdf: document.signedPdf,
      signedPdfKey: document.signedPdfKey,
    })
    .from(document)
    .where(and(eq(document.id, id), or(...access)));
  if (!doc || (!doc.signedPdf && !doc.signedPdfKey)) return null;
  return loadPdf(doc.signedPdf ?? "", doc.signedPdfKey);
};

/** Return the signed PDF for a document the given owner owns, else null */
export const getSignedPdfForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
): Promise<Uint8Array | null> => {
  const [doc] = await db
    .select({
      signedPdf: document.signedPdf,
      signedPdfKey: document.signedPdfKey,
    })
    .from(document)
    .where(and(eq(document.id, id), eq(document.ownerId, ownerId)));
  if (!doc || (!doc.signedPdf && !doc.signedPdfKey)) return null;
  return loadPdf(doc.signedPdf ?? "", doc.signedPdfKey);
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
  emitDocumentVoided({ documentId: id, ownerId: doc.ownerId });
  return true;
};
