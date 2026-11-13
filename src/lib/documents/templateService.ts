/**
 * Templates: a reusable document plus its field layout that an owner can start
 * new signing requests from. Templates are account-scoped (owner only).
 */

import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { Document, Template, TemplateField } from "../db/schema.ts";
import { document, field, signer, template } from "../db/schema.ts";
import { loadPdf } from "../storage/pdfStore.ts";
import type {
  DraftRequest,
  DraftSignerInput,
  SendResult,
} from "./documentService.ts";
import {
  createDraft,
  parseFieldOptions,
  sendOwnedDraft,
} from "./documentService.ts";

/** A template saved before roles existed has a single signer role */
const LEGACY_ROLES = ["Signer 1"];

/**
 * Store a document's PDF and field layout as a template owned by its owner.
 * Each signer becomes a role in signing order ("Signer 1", "Signer 2", ...) and
 * every field records the role of the signer it was assigned to, along with its
 * options, requirement and styling, so a template reproduces the whole layout.
 * Unassigned fields go to the first role.
 */
const storeTemplate = async (
  db: Db,
  doc: Document,
  ownerId: string,
): Promise<{ id: string }> => {
  const signers = await db
    .select({ id: signer.id })
    .from(signer)
    .where(eq(signer.documentId, doc.id))
    .orderBy(asc(signer.orderIndex));
  const roleOf = new Map(signers.map((s, i) => [s.id, i]));
  const fields = await db
    .select()
    .from(field)
    .where(eq(field.documentId, doc.id));
  const layout: TemplateField[] = fields.map((f) => ({
    type: f.type,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    role: f.signerId ? (roleOf.get(f.signerId) ?? 0) : 0,
    options: parseFieldOptions(f.options),
    required: f.required,
    groupId: f.groupId,
    dateFormat: f.dateFormat,
    color: f.color,
  }));
  const roles =
    signers.length > 0
      ? signers.map((_, i) => `Signer ${i + 1}`)
      : LEGACY_ROLES;

  // the template keeps the PDF inline (base64); load it from object storage
  // first when the source document's bytes were externalized
  const pdfBytes = await loadPdf(doc.originalPdf, doc.originalPdfKey);
  const [row] = await db
    .insert(template)
    .values({
      name: doc.name,
      ownerId,
      pdfBase64: Buffer.from(pdfBytes).toString("base64"),
      fields: layout,
      roles,
    })
    .returning({ id: template.id });
  if (!row) throw new Error("failed to create template");
  return { id: row.id };
};

/**
 * Save a draft's document and field layout as a template. The draft must have
 * an owner (the sender was signed in); returns null otherwise.
 */
export const saveTemplateFromDraft = async (
  db: Db,
  docId: string,
  manageToken: string,
): Promise<{ id: string } | null> => {
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, docId), eq(document.manageToken, manageToken)));
  if (!doc?.ownerId) return null;
  return storeTemplate(db, doc, doc.ownerId);
};

/**
 * Save a template from a draft the signed-in owner owns (by owner id, or a
 * shared workspace), for the app's owner-scoped flow. Returns null when the
 * caller may not access the document.
 */
export const saveTemplateFromOwnedDraft = async (
  db: Db,
  docId: string,
  ownerId: string,
  workspaceIds: string[],
): Promise<{ id: string } | null> => {
  const access =
    workspaceIds.length > 0
      ? or(
          eq(document.ownerId, ownerId),
          inArray(document.organizationId, workspaceIds),
        )
      : eq(document.ownerId, ownerId);
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, docId), access));
  if (!doc?.ownerId) return null;
  return storeTemplate(db, doc, doc.ownerId);
};

export interface TemplateSummary {
  id: string;
  name: string;
  createdAt: string;
  fieldCount: number;
  /** signer role labels in signing order; one signer is needed per role */
  roles: string[];
}

/** List an owner's templates, newest first */
export const listTemplates = async (
  db: Db,
  ownerId: string,
): Promise<TemplateSummary[]> => {
  const rows = await db
    .select()
    .from(template)
    .where(eq(template.ownerId, ownerId))
    .orderBy(desc(template.createdAt));
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    fieldCount: (t.fields ?? []).length,
    roles: t.roles ?? LEGACY_ROLES,
  }));
};

export type FromTemplateResult =
  | { ok: true; draft: DraftRequest }
  | { ok: false; error: "not_found" | "signers_for_each_role" };

/** The template an owner owns, or null */
const ownedTemplate = async (
  db: Db,
  templateId: string,
  ownerId: string,
): Promise<Template | null> => {
  const [tpl] = await db
    .select()
    .from(template)
    .where(and(eq(template.id, templateId), eq(template.ownerId, ownerId)));
  return tpl ?? null;
};

/** A draft of the template's PDF and layout, with signers filling its roles */
const draftFromTemplate = (
  db: Db,
  tpl: Template,
  ownerId: string,
  signers: DraftSignerInput[],
  ownerEmail?: string,
  organizationId?: string,
): Promise<DraftRequest> =>
  createDraft(db, {
    name: tpl.name,
    pdf: Uint8Array.from(Buffer.from(tpl.pdfBase64, "base64")),
    signers,
    ownerId,
    ownerEmail,
    organizationId,
    fields: tpl.fields ?? [],
  });

/**
 * Start a new draft from a template the owner owns. Signers fill the template's
 * roles in order, so each field lands with the signer of its role; there must
 * be at least one signer per role (extra signers are added with no fields)
 */
export const createDraftFromTemplate = async (
  db: Db,
  templateId: string,
  ownerId: string,
  signers: DraftSignerInput[],
  ownerEmail?: string,
  organizationId?: string,
): Promise<FromTemplateResult> => {
  const tpl = await ownedTemplate(db, templateId, ownerId);
  if (!tpl) return { ok: false, error: "not_found" };
  if (signers.length < (tpl.roles ?? LEGACY_ROLES).length)
    return { ok: false, error: "signers_for_each_role" };
  const draft = await draftFromTemplate(
    db,
    tpl,
    ownerId,
    signers,
    ownerEmail,
    organizationId,
  );
  return { ok: true, draft };
};

/** The most documents one bulk send may create, to bound a single request */
export const BULK_SEND_MAX = 100;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface BulkSendInput {
  templateId: string;
  ownerId: string;
  ownerEmail?: string;
  organizationId?: string;
  workspaceIds: string[];
  /** one row per document: a signer (name and email) for each template role */
  rows: DraftSignerInput[][];
}

export type BulkSendResult =
  | {
      ok: true;
      /** each row that became a sent document, with its signers' links */
      sent: ({ index: number; documentId: string } & SendResult)[];
      /** rows that failed after validation (the others were still sent) */
      failed: number[];
    }
  | { ok: false; error: "no_rows" | "too_many_rows" | "not_found" }
  | { ok: false; error: "invalid_rows"; rows: number[] };

/**
 * Send the same template to many recipients: each row becomes its own document
 * from the template, with that row's signers filling the roles, and is sent
 * immediately. Every row is validated before anything is created (a signer for
 * each role, each with a name and a deliverable email), so a bad batch never
 * half-sends. Rows run one at a time; a row that fails after validation is
 * reported and does not stop the rest.
 */
export const bulkSendFromTemplate = async (
  db: Db,
  input: BulkSendInput,
): Promise<BulkSendResult> => {
  if (input.rows.length === 0) return { ok: false, error: "no_rows" };
  if (input.rows.length > BULK_SEND_MAX)
    return { ok: false, error: "too_many_rows" };
  const tpl = await ownedTemplate(db, input.templateId, input.ownerId);
  if (!tpl) return { ok: false, error: "not_found" };

  const roleCount = (tpl.roles ?? LEGACY_ROLES).length;
  const invalid = input.rows.flatMap((row, i) =>
    row.length < roleCount ||
    row.some((s) => !s.name?.trim() || !EMAIL.test(s.email?.trim() ?? ""))
      ? [i]
      : [],
  );
  if (invalid.length > 0)
    return { ok: false, error: "invalid_rows", rows: invalid };

  const sent: ({ index: number; documentId: string } & SendResult)[] = [];
  const failed: number[] = [];
  for (const [index, row] of input.rows.entries()) {
    try {
      const draft = await draftFromTemplate(
        db,
        tpl,
        input.ownerId,
        row.map((s) => ({ name: s.name.trim(), email: s.email?.trim() })),
        input.ownerEmail,
        input.organizationId,
      );
      const result = await sendOwnedDraft(
        db,
        draft.id,
        input.ownerId,
        input.workspaceIds,
      );
      if (!result) throw new Error("send failed");
      sent.push({ index, documentId: draft.id, ...result });
    } catch (err) {
      console.error("[signet] bulk send row failed", index, err);
      failed.push(index);
    }
  }
  return { ok: true, sent, failed };
};
