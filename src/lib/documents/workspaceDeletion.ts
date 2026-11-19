import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  apiKey,
  document,
  field,
  signatureEvent,
  signer,
} from "../db/schema.ts";
import { deletePdf } from "../storage/pdfStore.ts";
import { pendingCancellation } from "./cancellation.ts";

export interface WorkspaceDeletionResult {
  /** documents deleted, each with its signers, fields, and audit trail */
  documents: number;
  /** API keys scoped to the workspace that were deleted */
  apiKeys: number;
  /**
   * Documents that were still out for signature, with the signers holding a
   * live link, so they can be told the request was canceled (the same as when
   * a sender deletes one document)
   */
  canceled: Awaited<ReturnType<typeof pendingCancellation>>[];
}

/**
 * Delete what Signet keeps for a deleted workspace (Gatekeeper organization):
 * every document that belongs to it, with its signers, fields, audit trail,
 * and stored PDFs, and the API keys scoped to it. Deleting the workspace is
 * the sender's deletion of its documents, so the signed record goes as a
 * whole, the same as when a sender deletes one document.
 *
 * Stored PDFs are deleted first and a storage failure throws, so the caller
 * retries before any row is gone (object keys are derived from the document,
 * so a document's PDFs can only be found while its row exists). The rows then
 * go in one transaction.
 *
 * Templates and saved signatures belong to a person's account rather than a
 * workspace, so they stay. Idempotent: a workspace with nothing left is a no-op
 */
export const deleteWorkspaceData = async (
  db: Db,
  organizationId: string,
): Promise<WorkspaceDeletionResult> => {
  const docs = await db
    .select({
      id: document.id,
      originalPdfKey: document.originalPdfKey,
      signedPdfKey: document.signedPdfKey,
    })
    .from(document)
    .where(eq(document.organizationId, organizationId));

  for (const doc of docs) {
    for (const key of [doc.originalPdfKey, doc.signedPdfKey]) {
      if (key) await deletePdf(key);
    }
  }

  const ids = docs.map((d) => d.id);

  // Read before the delete, which removes the signer rows it needs
  const canceled = (
    await Promise.all(ids.map((id) => pendingCancellation(db, id)))
  ).filter((pending) => pending.recipients.length > 0);

  const counts = await db.transaction(async (tx) => {
    if (ids.length > 0) {
      await tx
        .delete(signatureEvent)
        .where(inArray(signatureEvent.documentId, ids));
      await tx.delete(field).where(inArray(field.documentId, ids));
      await tx.delete(signer).where(inArray(signer.documentId, ids));
      await tx.delete(document).where(inArray(document.id, ids));
    }
    const keys = await tx
      .delete(apiKey)
      .where(eq(apiKey.organizationId, organizationId))
      .returning({ id: apiKey.id });
    return { documents: ids.length, apiKeys: keys.length };
  });

  return { ...counts, canceled };
};
