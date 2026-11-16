/**
 * Request expiry: a document still out for signature when its expiry passes
 * stops accepting signatures. Signers get a last reminder shortly before, and
 * once it expires every signer still holding a link and the sender are told.
 */

import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { document, signer } from "../db/schema.ts";
import type { CanceledRecipient } from "./cancellation.ts";
import { awaitingSigners, pendingCancellation } from "./cancellation.ts";
import { appendProvenance } from "./documentService.ts";

/** How long before expiry signers get their last reminder */
export const EXPIRY_WARNING_MS = 3 * 24 * 60 * 60 * 1000;

export interface ExpiringSoon {
  documentId: string;
  documentName: string;
  expiresAt: Date;
  /** signers still holding a live link */
  recipients: (CanceledRecipient & { signToken: string })[];
}

/**
 * Documents that expire within the warning window and have not been warned
 * yet, with whom to warn. Marks each as warned, so a signer is warned once
 */
export const takeExpiringSoon = async (
  db: Db,
  now: Date,
): Promise<ExpiringSoon[]> => {
  const docs = await db
    .select({
      id: document.id,
      name: document.name,
      expiresAt: document.expiresAt,
      signingMode: document.signingMode,
    })
    .from(document)
    .where(
      and(
        eq(document.status, "sent"),
        isNull(document.expiryWarnedAt),
        gt(document.expiresAt, now),
        lte(document.expiresAt, new Date(now.getTime() + EXPIRY_WARNING_MS)),
      ),
    );
  if (docs.length === 0) return [];

  const signers = await db
    .select({
      id: signer.id,
      documentId: signer.documentId,
      name: signer.name,
      email: signer.email,
      status: signer.status,
      orderIndex: signer.orderIndex,
      signToken: signer.signToken,
    })
    .from(signer)
    .where(
      inArray(
        signer.documentId,
        docs.map((d) => d.id),
      ),
    )
    .orderBy(asc(signer.orderIndex));

  const out: ExpiringSoon[] = [];
  for (const doc of docs) {
    if (!doc.expiresAt) continue;
    const mine = signers.filter((s) => s.documentId === doc.id);
    const tokenOf = new Map(mine.map((s) => [s.id, s.signToken]));
    const recipients = awaitingSigners(
      mine,
      doc.signingMode === "sequential",
    ).map((r) => ({ ...r, signToken: tokenOf.get(r.signerId) ?? "" }));

    await db
      .update(document)
      .set({ expiryWarnedAt: now })
      .where(eq(document.id, doc.id));
    // the warning stands in for the next routine reminder
    if (recipients.length > 0) {
      await db
        .update(signer)
        .set({ lastReminderAt: now })
        .where(
          and(
            eq(signer.documentId, doc.id),
            inArray(
              signer.id,
              recipients.map((r) => r.signerId),
            ),
          ),
        );
    }
    out.push({
      documentId: doc.id,
      documentName: doc.name,
      expiresAt: doc.expiresAt,
      recipients,
    });
  }
  return out;
};

export interface ExpiredDocument {
  documentId: string;
  documentName: string;
  ownerEmail: string | null;
  /** signers who still held a live link, to tell it expired */
  recipients: CanceledRecipient[];
  signed: string[];
  unsigned: string[];
}

/**
 * Expire every request past its expiry: mark it expired, record it in the
 * provenance chain, and return whom to tell
 */
export const expireDue = async (
  db: Db,
  now: Date,
): Promise<ExpiredDocument[]> => {
  const due = await db
    .select({
      id: document.id,
      name: document.name,
      ownerEmail: document.ownerEmail,
    })
    .from(document)
    .where(and(eq(document.status, "sent"), lte(document.expiresAt, now)));

  const out: ExpiredDocument[] = [];
  for (const doc of due) {
    // read who is waiting before the status changes
    const pending = await pendingCancellation(db, doc.id);
    const updated = await db
      .update(document)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(document.id, doc.id), eq(document.status, "sent")))
      .returning({ id: document.id });
    // signed or voided in the meantime
    if (updated.length === 0) continue;
    await appendProvenance(db, doc.id, {
      type: "document.expired",
      data: {},
    });
    const signers = await db
      .select({ name: signer.name, status: signer.status })
      .from(signer)
      .where(eq(signer.documentId, doc.id))
      .orderBy(asc(signer.orderIndex));
    out.push({
      documentId: doc.id,
      documentName: doc.name,
      ownerEmail: doc.ownerEmail,
      recipients: pending.recipients,
      signed: signers.filter((s) => s.status === "signed").map((s) => s.name),
      unsigned: signers.filter((s) => s.status !== "signed").map((s) => s.name),
    });
  }
  return out;
};
