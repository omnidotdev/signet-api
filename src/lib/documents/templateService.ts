/**
 * Templates: a reusable document plus its field layout that an owner can start
 * new signing requests from. Templates are account-scoped (owner only).
 */

import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { TemplateField } from "../db/schema.ts";
import { document, field, template } from "../db/schema.ts";
import { loadPdf } from "../storage/pdfStore.ts";
import type { DraftRequest, DraftSignerInput } from "./documentService.ts";
import { createDraft } from "./documentService.ts";

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

  const fields = await db
    .select()
    .from(field)
    .where(eq(field.documentId, docId));
  const layout: TemplateField[] = fields.map((f) => ({
    type: f.type,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
  }));

  // the template keeps the PDF inline (base64); load it from object storage
  // first when the source document's bytes were externalized
  const pdfBytes = await loadPdf(doc.originalPdf, doc.originalPdfKey);

  const [row] = await db
    .insert(template)
    .values({
      name: doc.name,
      ownerId: doc.ownerId,
      pdfBase64: Buffer.from(pdfBytes).toString("base64"),
      fields: layout,
    })
    .returning({ id: template.id });
  if (!row) throw new Error("failed to create template");
  return { id: row.id };
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

  const fields = await db
    .select()
    .from(field)
    .where(eq(field.documentId, docId));
  const layout: TemplateField[] = fields.map((f) => ({
    type: f.type,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
  }));
  const pdfBytes = await loadPdf(doc.originalPdf, doc.originalPdfKey);
  const [row] = await db
    .insert(template)
    .values({
      name: doc.name,
      ownerId: doc.ownerId,
      pdfBase64: Buffer.from(pdfBytes).toString("base64"),
      fields: layout,
    })
    .returning({ id: template.id });
  if (!row) throw new Error("failed to create template");
  return { id: row.id };
};

export interface TemplateSummary {
  id: string;
  name: string;
  createdAt: string;
  fieldCount: number;
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
  }));
};

/** Start a new draft from a template the owner owns, with the given signers */
export const createDraftFromTemplate = async (
  db: Db,
  templateId: string,
  ownerId: string,
  signers: DraftSignerInput[],
  ownerEmail?: string,
  organizationId?: string,
): Promise<DraftRequest | null> => {
  const [tpl] = await db
    .select()
    .from(template)
    .where(and(eq(template.id, templateId), eq(template.ownerId, ownerId)));
  if (!tpl) return null;

  const pdf = Uint8Array.from(Buffer.from(tpl.pdfBase64, "base64"));
  return createDraft(db, {
    name: tpl.name,
    pdf,
    signers,
    ownerId,
    ownerEmail,
    organizationId,
    fields: tpl.fields ?? [],
  });
};
