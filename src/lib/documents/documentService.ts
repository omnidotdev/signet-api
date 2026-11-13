import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { TemplateField } from "../db/schema.ts";
import { document, field, signatureEvent, signer } from "../db/schema.ts";
import { generateToken } from "../db/tokens.ts";
import { sendOtpEmail } from "../email/otpEmail.ts";
import {
  emitDocumentCompleted,
  emitDocumentCreated,
  emitDocumentSent,
  emitDocumentVoided,
  emitSignatureCompleted,
} from "../events/signetEvents.ts";
import { formatDate } from "../fields/dateFormat.ts";
import type { DetectedField } from "../fields/detect.ts";
import { detectFields } from "../fields/detect.ts";
import { signatureFontOrNull } from "../fields/signatureFonts.ts";
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
import type { CertificateData } from "./certificate.ts";
import { buildCompletionCertificate } from "./certificate.ts";
import {
  generateOtpCode,
  hashOtpCode,
  maskEmail,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  verifyOtpCode,
} from "./otp.ts";

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
  /** optional access code the signer must enter to open the document */
  accessCode?: string;
}

export interface MultiSignerRequestInput {
  name: string;
  pdf: Uint8Array;
  signers: DraftSignerInput[];
  /** "sequential" to require signing in order, else "parallel" (any order) */
  signingMode?: "parallel" | "sequential";
  /** "email_otp" to require signers to verify by one-time code, else "none" */
  verificationLevel?: "none" | "email_otp";
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
  const verificationLevel =
    input.verificationLevel === "email_otp" ? "email_otp" : "none";
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
      verificationLevel,
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
        accessCode: s.accessCode?.trim() || null,
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
  if (doc?.status !== "draft") return null;

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

export interface DocumentDetail {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  signingMode: string;
  hasSignedPdf: boolean;
  signers: {
    id: string;
    name: string;
    email: string | null;
    status: string;
    orderIndex: number;
    /** whether it is this signer's turn (parallel: always; sequential: in turn) */
    active: boolean;
  }[];
  history: { type: string; timestamp: string; signer: string | null }[];
  provenanceValid: boolean;
  trustedTimestamp: DocumentStatus["trustedTimestamp"];
}

const ownerAccess = (ownerId: string, workspaceIds: string[]) => {
  const access = [eq(document.ownerId, ownerId)];
  if (workspaceIds.length > 0) {
    access.push(inArray(document.organizationId, workspaceIds));
  }
  return or(...access);
};

/**
 * The document file for the owner (or a workspace member) at any stage: the
 * sealed PDF once signed, otherwise the original uploaded PDF, so a sender can
 * always open a document from their history. Null when not theirs.
 */
export const getDocumentFileForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
): Promise<{ bytes: Uint8Array; signed: boolean } | null> => {
  const [doc] = await db
    .select({
      originalPdf: document.originalPdf,
      originalPdfKey: document.originalPdfKey,
      signedPdf: document.signedPdf,
      signedPdfKey: document.signedPdfKey,
    })
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
  if (!doc) return null;

  const hasSigned = doc.signedPdf !== null || doc.signedPdfKey !== null;
  if (hasSigned) {
    return {
      bytes: await loadPdf(doc.signedPdf ?? "", doc.signedPdfKey),
      signed: true,
    };
  }
  return {
    bytes: await loadPdf(doc.originalPdf, doc.originalPdfKey),
    signed: false,
  };
};

/**
 * Full status + signing history for a document the owner owns (or shares
 * through a workspace), for the sender's tracking view. Null when not theirs.
 */
export const getDocumentDetailForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
): Promise<DocumentDetail | null> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
  if (!doc) return null;

  const signers = await db
    .select()
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));
  const firstUnsigned = signers.find((s) => s.status !== "signed")?.orderIndex;

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
    signingMode: doc.signingMode,
    hasSignedPdf: doc.signedPdf !== null || doc.signedPdfKey !== null,
    signers: signers.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      status: s.status,
      orderIndex: s.orderIndex,
      active:
        doc.signingMode !== "sequential" || s.orderIndex === firstUnsigned,
    })),
    history: chain.map((e) => ({
      type: e.type,
      timestamp: e.timestamp,
      signer:
        typeof (e.data as { signer?: unknown }).signer === "string"
          ? ((e.data as { signer: string }).signer ?? null)
          : null,
    })),
    provenanceValid: verifyLedger(chain).valid,
    trustedTimestamp: trustedTimestampFrom(chain),
  };
};

/**
 * Assemble the Certificate of Completion data for a document from its rows and
 * provenance chain: each signer's outcome and consent, the document
 * fingerprint, the trusted timestamp, and the ordered audit trail.
 */
const assembleCertificate = (
  doc: typeof document.$inferSelect,
  signers: (typeof signer.$inferSelect)[],
  chain: ProvenanceEvent[],
): CertificateData => {
  // signing metadata per signer, keyed by the adopted name on the signed event:
  // consent affirmation plus the audit-trail network identity (IP, user-agent)
  const consentByName = new Map<string, boolean>();
  const actorByName = new Map<
    string,
    { ip: string | null; userAgent: string | null }
  >();
  const verificationByName = new Map<
    string,
    { method: string; verifiedAt: string } | null
  >();
  for (const e of chain) {
    if (e.type !== "document.signed") continue;
    const d = e.data as {
      signer?: unknown;
      consent?: unknown;
      ip?: unknown;
      userAgent?: unknown;
      verification?: unknown;
    };
    if (typeof d.signer === "string") {
      consentByName.set(d.signer, d.consent === true);
      actorByName.set(d.signer, {
        ip: typeof d.ip === "string" ? d.ip : null,
        userAgent: typeof d.userAgent === "string" ? d.userAgent : null,
      });
      const v = d.verification as
        | { method?: unknown; verifiedAt?: unknown }
        | null
        | undefined;
      verificationByName.set(
        d.signer,
        v && typeof v.method === "string" && typeof v.verifiedAt === "string"
          ? { method: v.method, verifiedAt: v.verifiedAt }
          : null,
      );
    }
  }
  const completed = chain.find((e) => e.type === "document.completed");

  return {
    documentName: doc.name,
    documentId: doc.id,
    contentHash: doc.contentHash ?? null,
    createdAt: doc.createdAt.toISOString(),
    completedAt: completed?.timestamp ?? null,
    provenanceValid: verifyLedger(chain).valid,
    trustedTimestamp: trustedTimestampFrom(chain),
    signers: signers.map((s) => ({
      name: s.name,
      email: s.email,
      signedAt: s.signedAt ? s.signedAt.toISOString() : null,
      consent: consentByName.get(s.name) ?? false,
      ip: actorByName.get(s.name)?.ip ?? null,
      userAgent: actorByName.get(s.name)?.userAgent ?? null,
      verification: verificationByName.get(s.name) ?? null,
    })),
    events: chain.map((e) => ({
      type: e.type,
      timestamp: e.timestamp,
      signer:
        typeof (e.data as { signer?: unknown }).signer === "string"
          ? ((e.data as { signer: string }).signer ?? null)
          : null,
    })),
  };
};

/** Load the ledger chain for a document id */
const loadChain = async (db: Db, id: string): Promise<ProvenanceEvent[]> => {
  const events = await db
    .select()
    .from(signatureEvent)
    .where(eq(signatureEvent.documentId, id))
    .orderBy(asc(signatureEvent.index));
  return events.map((r) => ({
    index: r.index,
    timestamp: r.createdAt.toISOString(),
    type: r.type,
    data: r.data as Record<string, unknown>,
    prevHash: r.prevHash,
    hash: r.hash,
  }));
};

/**
 * Build the Certificate of Completion PDF for a document the owner owns. Null
 * when the owner may not see it or the document has not completed yet.
 */
export const buildCertificateForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
): Promise<Uint8Array | null> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
  if (doc?.status !== "completed") return null;
  const signers = await db
    .select()
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));
  const chain = await loadChain(db, id);
  return buildCompletionCertificate(assembleCertificate(doc, signers, chain));
};

/**
 * Build the Certificate of Completion PDF for a signer's token, once the
 * document has completed. Null when the token is unknown or not yet complete.
 */
export const buildCertificateForToken = async (
  db: Db,
  signToken: string,
): Promise<Uint8Array | null> => {
  const [sgn] = await db
    .select()
    .from(signer)
    .where(eq(signer.signToken, signToken));
  if (!sgn) return null;
  const [doc] = await db
    .select()
    .from(document)
    .where(eq(document.id, sgn.documentId));
  if (doc?.status !== "completed") return null;
  const signers = await db
    .select()
    .from(signer)
    .where(eq(signer.documentId, doc.id))
    .orderBy(asc(signer.orderIndex));
  const chain = await loadChain(db, doc.id);
  return buildCompletionCertificate(assembleCertificate(doc, signers, chain));
};

/**
 * The pending signers to remind now for a document the owner owns: those not
 * yet signed and currently active (sequential: only the current signer), with
 * an email. Stamps lastReminderAt. Null when the document is not the owner's or
 * not awaiting signatures. Pass signerId to remind only that one signer, still
 * subject to the same pending + in-turn eligibility.
 */
export const remindOwnedDocument = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
  signerId?: string,
): Promise<{
  documentName: string;
  signers: { name: string; email: string; signToken: string }[];
} | null> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
  if (doc?.status !== "sent") return null;

  const signers = await db
    .select()
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));
  const firstUnsigned = signers.find((s) => s.status !== "signed")?.orderIndex;

  const pending = signers.filter(
    (s) =>
      s.status !== "signed" &&
      s.email &&
      (!signerId || s.id === signerId) &&
      (doc.signingMode !== "sequential" || s.orderIndex === firstUnsigned),
  );
  if (pending.length === 0) return null;

  await db
    .update(signer)
    .set({ lastReminderAt: new Date() })
    .where(
      inArray(
        signer.id,
        pending.map((s) => s.id),
      ),
    );

  return {
    documentName: doc.name,
    signers: pending.map((s) => ({
      name: s.name,
      email: s.email as string,
      signToken: s.signToken,
    })),
  };
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
  /** "email_otp" to require signers to verify by one-time code, else "none" */
  verificationLevel?: "none" | "email_otp";
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
      verificationLevel:
        input.verificationLevel === "email_otp" ? "email_otp" : "none",
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
        accessCode: s.accessCode?.trim() || null,
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
  /** choices for a dropdown or radio field */
  options?: string[] | null;
  /** whether the signer must fill this field before submitting */
  required?: boolean;
  /** links mutually-exclusive radio buttons into one group */
  groupId?: string | null;
  /** date style for a date field: iso | us | eu | long */
  dateFormat?: string | null;
  /** ink for this field's stamped mark, as #rrggbb */
  color?: string | null;
}

/** Parse the stored options JSON (a dropdown/radio field's choices) */
export const parseFieldOptions = (raw: string | null): string[] | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((o): o is string => typeof o === "string")
      : null;
  } catch {
    return null;
  }
};

/** Serialize a field's options to JSON for storage, or null when there are none */
const serializeFieldOptions = (
  options: string[] | null | undefined,
): string | null =>
  options && options.length > 0 ? JSON.stringify(options) : null;

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
      options: parseFieldOptions(f.options),
      required: f.required,
      groupId: f.groupId,
      dateFormat: f.dateFormat,
      color: f.color,
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
  if (doc?.status !== "draft") return false;

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
        options: serializeFieldOptions(f.options),
        required: f.required ?? true,
        groupId: f.groupId ?? null,
        dateFormat: f.dateFormat ?? null,
        color: f.color ?? null,
      })),
    );
  }
  return true;
};

/**
 * Editor data for a draft the owner owns (or shares through a workspace), for
 * the native field editor. Null when not theirs. Only a draft can be edited.
 */
export const getEditorDataForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
): Promise<EditorData | null> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
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
      options: parseFieldOptions(f.options),
      required: f.required,
      groupId: f.groupId,
      dateFormat: f.dateFormat,
      color: f.color,
    })),
  };
};

/**
 * Replace a draft's fields, for a draft the owner owns (or shares through a
 * workspace). Fields assigned to an unknown signer are stored unassigned.
 * Returns false when the document is not an editable draft of the owner's.
 */
export const saveFieldsForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
  fields: EditorField[],
): Promise<boolean> => {
  const [doc] = await db
    .select({ status: document.status })
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
  if (doc?.status !== "draft") return false;

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
        options: serializeFieldOptions(f.options),
        required: f.required ?? true,
        groupId: f.groupId ?? null,
        dateFormat: f.dateFormat ?? null,
        color: f.color ?? null,
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
  if (doc?.status !== "draft") return null;

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
  if (doc?.status !== "draft") return null;
  return doc;
};

/**
 * Load a draft by id scoped to the signed-in owner (or one of their
 * workspaces), the owner-session counterpart to loadDraftForManage. Signers can
 * still be changed only while the document is a draft.
 */
const loadDraftForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
): Promise<{ id: string; status: string } | null> => {
  const [doc] = await db
    .select({ id: document.id, status: document.status })
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
  if (doc?.status !== "draft") return null;
  return doc;
};

export interface AddedSigner {
  id: string;
  name: string;
  email: string | null;
  color: string;
  signToken: string;
}

/** Add a signer to a verified draft (shared by the manage-token and owner
    entry points). Returns the new signer, or null for a blank name. */
const insertDraftSigner = async (
  db: Db,
  id: string,
  input: DraftSignerInput,
): Promise<AddedSigner | null> => {
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

/** Remove a signer from a verified draft: delete their fields, re-normalize the
    order, and refuse to remove the last signer. Returns false if not possible. */
const deleteDraftSigner = async (
  db: Db,
  id: string,
  signerId: string,
): Promise<boolean> => {
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

/** Update a signer's name/email on a verified draft. Returns false if unknown
    or the name is blanked. */
const patchDraftSigner = async (
  db: Db,
  id: string,
  signerId: string,
  input: { name?: string; email?: string | null },
): Promise<boolean> => {
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

/** Add a signer to a draft via manage token (draft only). */
export const addSignerToDraft = async (
  db: Db,
  id: string,
  manageToken: string,
  input: DraftSignerInput,
): Promise<AddedSigner | null> => {
  const doc = await loadDraftForManage(db, id, manageToken);
  if (!doc) return null;
  return insertDraftSigner(db, id, input);
};

/** Add a signer to a draft the signed-in owner owns (draft only). */
export const addSignerForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
  input: DraftSignerInput,
): Promise<AddedSigner | null> => {
  const doc = await loadDraftForOwner(db, id, ownerId, workspaceIds);
  if (!doc) return null;
  return insertDraftSigner(db, id, input);
};

/** Remove a signer from a draft via manage token (draft only). */
export const removeSignerFromDraft = async (
  db: Db,
  id: string,
  manageToken: string,
  signerId: string,
): Promise<boolean> => {
  const doc = await loadDraftForManage(db, id, manageToken);
  if (!doc) return false;
  return deleteDraftSigner(db, id, signerId);
};

/** Remove a signer from a draft the signed-in owner owns (draft only). */
export const removeSignerForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
  signerId: string,
): Promise<boolean> => {
  const doc = await loadDraftForOwner(db, id, ownerId, workspaceIds);
  if (!doc) return false;
  return deleteDraftSigner(db, id, signerId);
};

/** Update a draft signer's name/email via manage token (draft only). */
export const updateDraftSigner = async (
  db: Db,
  id: string,
  manageToken: string,
  signerId: string,
  input: { name?: string; email?: string | null },
): Promise<boolean> => {
  const doc = await loadDraftForManage(db, id, manageToken);
  if (!doc) return false;
  return patchDraftSigner(db, id, signerId, input);
};

/** Update a draft signer's name/email on a draft the owner owns (draft only). */
export const updateSignerForOwner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
  signerId: string,
  input: { name?: string; email?: string | null },
): Promise<boolean> => {
  const doc = await loadDraftForOwner(db, id, ownerId, workspaceIds);
  if (!doc) return false;
  return patchDraftSigner(db, id, signerId, input);
};

export interface CorrectSignerInput {
  name?: string;
  email?: string | null;
}

export interface CorrectedSigner {
  id: string;
  name: string;
  email: string | null;
  signToken: string;
  documentName: string;
  /** true when the email changed: the sign token was rotated, so the old link
      no longer works and the caller must send the new one */
  reissued: boolean;
}

/**
 * Correct a still-pending signer on a sent document (owner-scoped): fix a typo
 * in the name or reassign the email of someone who has not yet signed or
 * declined. Changing the email rotates the signer's sign token, invalidating
 * the old link, so the caller must email the new one. A signer who has already
 * signed or declined is immutable, which preserves the integrity of a signature
 * already captured. Returns null when the document is not sent, the signer is
 * unknown, or the signer is no longer pending.
 */
export const correctOwnedSigner = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
  signerId: string,
  input: CorrectSignerInput,
): Promise<CorrectedSigner | null> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
  if (doc?.status !== "sent") return null;

  const [existing] = await db
    .select()
    .from(signer)
    .where(and(eq(signer.id, signerId), eq(signer.documentId, id)));
  if (!existing) return null;
  // only someone still awaiting action can be corrected
  if (existing.status === "signed" || existing.status === "declined")
    return null;

  const patch: { name?: string; email?: string | null; signToken?: string } =
    {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return null;
    if (name !== existing.name) patch.name = name;
  }

  let reissued = false;
  if (input.email !== undefined) {
    const email = input.email?.trim() || null;
    if (email !== existing.email) {
      patch.email = email;
      // a changed recipient must not inherit the previous capability link
      patch.signToken = generateToken();
      reissued = true;
    }
  }

  if (Object.keys(patch).length === 0) {
    // nothing actually changed; report the signer as-is
    return {
      id: existing.id,
      name: existing.name,
      email: existing.email,
      signToken: existing.signToken,
      documentName: doc.name,
      reissued: false,
    };
  }

  const [row] = await db
    .update(signer)
    .set(patch)
    .where(eq(signer.id, signerId))
    .returning({
      id: signer.id,
      name: signer.name,
      email: signer.email,
      signToken: signer.signToken,
    });
  if (!row) throw new Error("failed to correct signer");

  await appendProvenance(db, id, {
    type: "signer.corrected",
    data: { signer: row.name, reissued },
  });

  return { ...row, documentName: doc.name, reissued };
};

/**
 * Add a signer to a sent document (owner-scoped): a late party the owner needs
 * to bring in after sending. The new signer is appended (they sign last in
 * sequential mode) with no pre-placed fields, so they act as an approver; the
 * caller emails them their link. Returns the new signer plus the document name,
 * or null when the document is not sent.
 */
export const addSignerToSentDocument = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
  input: DraftSignerInput,
): Promise<(AddedSigner & { documentName: string }) | null> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
  if (doc?.status !== "sent") return null;
  const added = await insertDraftSigner(db, id, input);
  if (!added) return null;
  return { ...added, documentName: doc.name };
};

/**
 * Remove a still-pending signer from a sent document (owner-scoped): a party
 * added in error. Their (unsigned) fields go with them and the order is
 * re-normalized. A signer who has signed or declined is immutable. Refuses to
 * remove the last signer, and refuses a removal that would leave every
 * remaining signer already signed (which would strand the document unsealed).
 * Returns false when any of those conditions hold.
 */
export const removePendingSignerFromSent = async (
  db: Db,
  id: string,
  ownerId: string,
  workspaceIds: string[],
  signerId: string,
): Promise<boolean> => {
  const [doc] = await db
    .select({ id: document.id, status: document.status })
    .from(document)
    .where(and(eq(document.id, id), ownerAccess(ownerId, workspaceIds)));
  if (doc?.status !== "sent") return false;

  const roster = await db
    .select({ id: signer.id, name: signer.name, status: signer.status })
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));
  const target = roster.find((s) => s.id === signerId);
  if (!target) return false;
  // a captured or refused signature is immutable
  if (target.status === "signed" || target.status === "declined") return false;

  const remaining = roster.filter((s) => s.id !== signerId);
  if (remaining.length === 0) return false; // keep at least one signer
  // removing this one must not leave a document whose remaining signers have
  // all signed but which was never sealed (it would be stuck forever)
  if (remaining.every((s) => s.status === "signed")) return false;

  await deleteDraftSigner(db, id, signerId);
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
  /** choices for a dropdown or radio field */
  options?: string[] | null;
  /** whether the signer must fill this field before submitting */
  required?: boolean;
  /** links mutually-exclusive radio buttons into one group */
  groupId?: string | null;
  /** date style for a date field: iso | us | eu | long */
  dateFormat?: string | null;
  /** ink for this field's stamped mark, as #rrggbb */
  color?: string | null;
}

export interface SignerFillData {
  documentName: string;
  signerName: string;
  /** this signer's assigned color, for tinting their fields */
  signerColor: string | null;
  alreadySigned: boolean;
  /** whether the whole document is complete (every signer done, sealed) */
  documentCompleted: boolean;
  /** in sequential mode, the name of the signer who must sign first, else null */
  waitingFor: string | null;
  pdfBase64: string;
  fields: SignerFillField[];
}

/**
 * Whether a signer's token can be opened: "not_found" for an unknown token,
 * "locked" when the signer has an access code and the supplied one does not
 * match (only while they still have to act), else "ok". Checked before any
 * fill data is revealed or a view is recorded.
 */
export const verifySignerAccess = async (
  db: Db,
  signToken: string,
  providedCode?: string,
): Promise<"ok" | "locked" | "not_found"> => {
  const [row] = await db
    .select({
      accessCode: signer.accessCode,
      signerStatus: signer.status,
      documentStatus: document.status,
    })
    .from(signer)
    .innerJoin(document, eq(signer.documentId, document.id))
    .where(eq(signer.signToken, signToken));
  if (!row) return "not_found";
  if (
    row.accessCode &&
    row.signerStatus !== "signed" &&
    row.documentStatus !== "completed" &&
    (providedCode ?? "").trim() !== row.accessCode
  ) {
    return "locked";
  }
  return "ok";
};

/** A signer's identity-verification state for a sign token */
export interface VerificationState {
  /** whether this signer must verify by one-time code before signing */
  required: boolean;
  /** whether this signer has already verified */
  verified: boolean;
  /** the signer's email, where a code is sent (null if none on file) */
  email: string | null;
  /** the signer's email, partially masked for display */
  maskedEmail: string | null;
  signerName: string;
  /** whether this signer already signed (no verification needed) */
  alreadySigned: boolean;
  /** whether the whole document is complete */
  completed: boolean;
}

/**
 * Resolve a sign token to its identity-verification state. Verification is
 * required only when the document asks for email OTP and the signer has an
 * email to receive it; a signer who already signed, or a completed document,
 * never needs to verify. Returns null for an unknown token.
 */
export const verificationStateFor = async (
  db: Db,
  signToken: string,
): Promise<VerificationState | null> => {
  const [row] = await db
    .select({
      verificationLevel: document.verificationLevel,
      documentStatus: document.status,
      email: signer.email,
      signerName: signer.name,
      signerStatus: signer.status,
      otpVerifiedAt: signer.otpVerifiedAt,
    })
    .from(signer)
    .innerJoin(document, eq(signer.documentId, document.id))
    .where(eq(signer.signToken, signToken));
  if (!row) return null;
  const alreadySigned = row.signerStatus === "signed";
  const completed = row.documentStatus === "completed";
  const required =
    row.verificationLevel === "email_otp" &&
    Boolean(row.email) &&
    !alreadySigned &&
    !completed;
  return {
    required,
    verified: row.otpVerifiedAt !== null,
    email: row.email,
    maskedEmail: row.email ? maskEmail(row.email) : null,
    signerName: row.signerName,
    alreadySigned,
    completed,
  };
};

export interface OtpIssueResult {
  ok: boolean;
  error?: "not_found" | "not_required" | "already_verified";
  maskedEmail?: string | null;
}

/**
 * Generate, store, and email a fresh one-time code to a signer, resetting the
 * attempt counter. The plaintext code is emailed and never returned, so it
 * cannot leak through the API or logs.
 */
const issueSignerOtp = async (
  db: Db,
  state: VerificationState,
  signToken: string,
  documentName: string,
): Promise<void> => {
  if (!state.email) return;
  const code = generateOtpCode();
  await db
    .update(signer)
    .set({
      otpCodeHash: await hashOtpCode(code),
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      otpAttempts: 0,
    })
    .where(eq(signer.signToken, signToken));
  await sendOtpEmail({
    to: state.email,
    signerName: state.signerName,
    documentName,
    code,
  });
};

/** The document name for a sign token, for the code email */
const documentNameForToken = async (
  db: Db,
  signToken: string,
): Promise<string> => {
  const [row] = await db
    .select({ name: document.name })
    .from(signer)
    .innerJoin(document, eq(signer.documentId, document.id))
    .where(eq(signer.signToken, signToken));
  return row?.name ?? "your document";
};

/**
 * Ensure a signer has a live code to enter, sending one only when verification
 * is required and no unexpired code is outstanding. Safe to call on every load
 * of the verification screen without spamming the signer's inbox.
 */
export const ensureSignerOtp = async (
  db: Db,
  signToken: string,
): Promise<OtpIssueResult> => {
  const state = await verificationStateFor(db, signToken);
  if (!state) return { ok: false, error: "not_found" };
  if (!state.required) return { ok: false, error: "not_required" };
  if (state.verified)
    return {
      ok: true,
      error: "already_verified",
      maskedEmail: state.maskedEmail,
    };

  const [row] = await db
    .select({ otpExpiresAt: signer.otpExpiresAt })
    .from(signer)
    .where(eq(signer.signToken, signToken));
  const hasLiveCode =
    row?.otpExpiresAt != null && row.otpExpiresAt.getTime() > Date.now();
  if (!hasLiveCode) {
    await issueSignerOtp(
      db,
      state,
      signToken,
      await documentNameForToken(db, signToken),
    );
  }
  return { ok: true, maskedEmail: state.maskedEmail };
};

/**
 * Always issue a fresh code, for an explicit "resend" from the signer. Burns
 * any outstanding code and resets the attempt counter.
 */
export const resendSignerOtp = async (
  db: Db,
  signToken: string,
): Promise<OtpIssueResult> => {
  const state = await verificationStateFor(db, signToken);
  if (!state) return { ok: false, error: "not_found" };
  if (!state.required) return { ok: false, error: "not_required" };
  if (state.verified)
    return {
      ok: true,
      error: "already_verified",
      maskedEmail: state.maskedEmail,
    };
  await issueSignerOtp(
    db,
    state,
    signToken,
    await documentNameForToken(db, signToken),
  );
  return { ok: true, maskedEmail: state.maskedEmail };
};

export interface OtpVerifyResult {
  ok: boolean;
  error?:
    | "not_found"
    | "not_required"
    | "no_code"
    | "expired"
    | "too_many_attempts"
    | "invalid_code";
}

/**
 * Check a submitted one-time code. On success the signer is marked verified
 * (sticky) and an `identity.verified` event is written into the provenance
 * chain, so the certificate can attest how the signer was identified. On a
 * wrong code the attempt is counted and the code is burned after too many.
 */
export const verifySignerOtp = async (
  db: Db,
  signToken: string,
  code: string,
): Promise<OtpVerifyResult> => {
  const state = await verificationStateFor(db, signToken);
  if (!state) return { ok: false, error: "not_found" };
  if (state.verified) return { ok: true };
  if (!state.required) return { ok: false, error: "not_required" };

  const [row] = await db
    .select({
      id: signer.id,
      documentId: signer.documentId,
      name: signer.name,
      email: signer.email,
      otpCodeHash: signer.otpCodeHash,
      otpExpiresAt: signer.otpExpiresAt,
      otpAttempts: signer.otpAttempts,
    })
    .from(signer)
    .where(eq(signer.signToken, signToken));
  if (!row?.otpCodeHash || !row.otpExpiresAt)
    return { ok: false, error: "no_code" };
  if (row.otpExpiresAt.getTime() <= Date.now())
    return { ok: false, error: "expired" };
  if (row.otpAttempts >= OTP_MAX_ATTEMPTS)
    return { ok: false, error: "too_many_attempts" };

  const matches = await verifyOtpCode((code ?? "").trim(), row.otpCodeHash);
  if (!matches) {
    await db
      .update(signer)
      .set({ otpAttempts: row.otpAttempts + 1 })
      .where(eq(signer.id, row.id));
    return { ok: false, error: "invalid_code" };
  }

  const verifiedAt = new Date();
  await db
    .update(signer)
    .set({ otpVerifiedAt: verifiedAt, otpCodeHash: null, otpExpiresAt: null })
    .where(eq(signer.id, row.id));
  await appendProvenance(db, row.documentId, {
    type: "identity.verified",
    data: {
      signer: row.name,
      email: row.email ?? null,
      method: "email_otp",
      verifiedAt: verifiedAt.toISOString(),
    },
  });
  return { ok: true };
};

/**
 * Everything the signer's fill overlay needs: the document, this signer's
 * fields, and the PDF. Records a view event the first time, like getSignerView.
 * Callers gate on verifySignerAccess first when an access code may apply.
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
      signerColor: signer.color,
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

  const fieldRows = await db
    .select({
      id: field.id,
      type: field.type,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
      options: field.options,
      required: field.required,
      groupId: field.groupId,
      dateFormat: field.dateFormat,
      color: field.color,
    })
    .from(field)
    .where(eq(field.signerId, row.signerId));
  const fields = fieldRows.map((f) => ({
    ...f,
    options: parseFieldOptions(f.options),
  }));
  const pdfBase64 = toBase64(
    await loadPdf(row.originalPdf, row.originalPdfKey),
  );

  return {
    documentName: row.documentName,
    signerName: row.signerName,
    signerColor: row.signerColor,
    alreadySigned:
      row.documentStatus === "completed" || row.signerStatus === "signed",
    documentCompleted: row.documentStatus === "completed",
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
  /**
   * handwriting style for a typed signature (see signatureFonts); anything
   * unrecognized is stored as null, the classic style
   */
  signatureFont?: string | null;
  /** per-field text the signer typed, keyed by field id */
  textValues?: Record<string, string>;
  /** the signer affirmed the electronic-records (ESIGN / UETA) consent */
  consent?: boolean;
  /** access code the signer entered, checked against the signer's code */
  accessCode?: string;
  /**
   * network identity of the signer at the moment of signing, captured for the
   * audit trail (origin IP and browser user-agent). Recorded into the signed
   * provenance event and surfaced on the Certificate of Completion
   */
  actor?: { ip?: string | null; userAgent?: string | null };
  /**
   * the caller has already established the signer's identity out of band (e.g.
   * an authenticated owner signing their own copy), so the email one-time-code
   * gate is satisfied without a code
   */
  identityAssured?: boolean;
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
  // enforce the access code server-side, never trust the client gate alone
  if (sgn.accessCode && (options?.accessCode ?? "").trim() !== sgn.accessCode)
    return { ok: false, error: "locked" };

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

  // identity assurance: when the document requires email verification, the
  // signer must have proven their identity with a one-time code before any
  // signature is accepted. Enforced server-side, never trusting the client gate
  if (
    doc.verificationLevel === "email_otp" &&
    sgn.email &&
    sgn.otpVerifiedAt === null &&
    options?.identityAssured !== true
  )
    return { ok: false, error: "verification_required" };

  // ESIGN / UETA: the signer must affirmatively consent to sign electronically
  // before any signature is accepted. This is a hard gate, not a recorded flag:
  // a signature without consent is never applied
  if (options?.consent !== true)
    return { ok: false, error: "consent_required" };

  const adopted = signatureName?.trim() || sgn.name;
  const dateStamp = new Date().toISOString().slice(0, 10);

  // fill this signer's fields: typed text where provided, else derived values
  const myFields = await db
    .select()
    .from(field)
    .where(and(eq(field.documentId, doc.id), eq(field.signerId, sgn.id)));

  // a required field must be filled before the signature is accepted. Signature
  // and initials are satisfied by the adopted signature; a date fills itself
  const hasAdopted = Boolean(adopted || options?.signatureImage);
  const missingRequired = myFields.some((f) => {
    if (!f.required) return false;
    const typed = options?.textValues?.[f.id];
    if (f.type === "checkbox") return (typed ?? f.value) !== "true";
    if (f.type === "text" || f.type === "dropdown" || f.type === "radio")
      return !(typed ?? f.value ?? "").trim();
    if (f.type === "signature" || f.type === "initials") return !hasAdopted;
    return false;
  });
  if (missingRequired) return { ok: false, error: "missing_required" };

  for (const f of myFields) {
    const typed = options?.textValues?.[f.id];
    // text, checkbox, dropdown and radio fields carry the signer's own input
    // (free text, "true"/"" for a checkbox, or the chosen option); a date is
    // editable but defaults to today; the rest derive from the adopted signature
    let value: string;
    if (f.type === "date") {
      // render the ISO date through the sender's chosen style (us/eu/long),
      // leaving a signer's free-typed value untouched
      value = formatDate(typed ?? f.value ?? dateStamp, f.dateFormat);
    } else if (
      f.type === "text" ||
      f.type === "checkbox" ||
      f.type === "dropdown" ||
      f.type === "radio"
    ) {
      value = typed ?? f.value ?? "";
    } else {
      value = fieldValueFor(f.type, adopted, dateStamp);
    }
    await db.update(field).set({ value }).where(eq(field.id, f.id));
  }

  await db
    .update(signer)
    .set({
      status: "signed",
      signedAt: new Date(),
      signatureImage: options?.signatureImage ?? null,
      // a drawn signature carries its own look; the style only shapes typing
      signatureFont: options?.signatureImage
        ? null
        : signatureFontOrNull(options?.signatureFont),
    })
    .where(eq(signer.id, sgn.id));
  await appendProvenance(db, doc.id, {
    type: "document.signed",
    data: {
      signer: adopted,
      email: sgn.email ?? null,
      contentHash: doc.contentHash,
      fields: myFields.length,
      // always true here: signing is gated on consent above
      consent: true,
      ip: options?.actor?.ip ?? null,
      userAgent: options?.actor?.userAgent ?? null,
      // how the signer's identity was assured, when the document required it
      verification:
        doc.verificationLevel === "email_otp" && sgn.otpVerifiedAt
          ? { method: "email_otp", verifiedAt: sgn.otpVerifiedAt.toISOString() }
          : null,
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
    const fontBySigner = new Map(signers.map((s) => [s.id, s.signatureFont]));
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
        options: parseFieldOptions(f.options),
        color: f.color,
        font:
          (f.type === "signature" || f.type === "initials") && f.signerId
            ? (fontBySigner.get(f.signerId) ?? null)
            : null,
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

export interface DeclineResult {
  ok: boolean;
  error?: string;
  documentName?: string;
  signerName?: string;
  ownerEmail?: string | null;
}

/**
 * A signer declines to sign: mark them declined and void the whole document so
 * no one can sign it further, recording the decline (and any reason) in the
 * provenance ledger. Enforces the signer's access code, like signing.
 */
export const declineByToken = async (
  db: Db,
  signToken: string,
  reason?: string,
  accessCode?: string,
): Promise<DeclineResult> => {
  const [sgn] = await db
    .select()
    .from(signer)
    .where(eq(signer.signToken, signToken));
  if (!sgn) return { ok: false, error: "not_found" };
  if (sgn.status === "signed") return { ok: false, error: "already_signed" };
  if (sgn.accessCode && (accessCode ?? "").trim() !== sgn.accessCode)
    return { ok: false, error: "locked" };

  const [doc] = await db
    .select()
    .from(document)
    .where(eq(document.id, sgn.documentId));
  if (!doc) return { ok: false, error: "not_found" };
  if (doc.status === "completed")
    return { ok: false, error: "already_completed" };
  if (doc.status === "voided") return { ok: false, error: "voided" };

  await db
    .update(signer)
    .set({ status: "declined" })
    .where(eq(signer.id, sgn.id));
  await db
    .update(document)
    .set({ status: "voided", updatedAt: new Date() })
    .where(eq(document.id, doc.id));
  await appendProvenance(db, doc.id, {
    type: "document.declined",
    data: { signer: sgn.name, reason: reason?.trim() || null },
  });
  emitDocumentVoided({ documentId: doc.id, ownerId: doc.ownerId });
  return {
    ok: true,
    documentName: doc.name,
    signerName: sgn.name,
    ownerEmail: doc.ownerEmail,
  };
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
