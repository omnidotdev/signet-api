import { asc, eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { document, signer } from "../db/schema.ts";

/** A signer to tell that a request they were sent no longer stands */
export interface CanceledRecipient {
  name: string;
  email: string;
}

interface SignerRow {
  id: string;
  name: string;
  email: string | null;
  status: string;
  orderIndex: number;
}

/**
 * The signers who were sent a request and still hold a live link: they have an
 * email, have not signed or declined, and have actually been sent the request.
 * In parallel signing everyone is sent it at once; in order, only the signer
 * whose turn it is has been (plus anyone who already opened their link).
 */
export const awaitingSigners = (
  signers: SignerRow[],
  sequential: boolean,
  excludeId?: string,
): CanceledRecipient[] => {
  const ordered = [...signers].sort((a, b) => a.orderIndex - b.orderIndex);
  const current = ordered.find((s) => s.status !== "signed");
  return ordered
    .filter(
      (s): s is SignerRow & { email: string } =>
        Boolean(s.email) &&
        s.id !== excludeId &&
        s.status !== "signed" &&
        s.status !== "declined" &&
        (!sequential || s === current || s.status === "viewed"),
    )
    .map((s) => ({ name: s.name, email: s.email }));
};

/**
 * Who to notify if a document is canceled (voided, replaced, or deleted) right
 * now. Only a request still out for signature has anyone waiting on it; a draft
 * was never sent and a completed or voided one is already settled. Read this
 * before the change, since a delete removes the signer rows it needs.
 */
export const pendingCancellation = async (
  db: Db,
  documentId: string,
  excludeSignerId?: string,
): Promise<{ documentName: string; recipients: CanceledRecipient[] }> => {
  const [doc] = await db
    .select({
      name: document.name,
      status: document.status,
      signingMode: document.signingMode,
    })
    .from(document)
    .where(eq(document.id, documentId));
  if (doc?.status !== "sent") {
    return { documentName: doc?.name ?? "", recipients: [] };
  }
  const signers = await db
    .select({
      id: signer.id,
      name: signer.name,
      email: signer.email,
      status: signer.status,
      orderIndex: signer.orderIndex,
    })
    .from(signer)
    .where(eq(signer.documentId, documentId))
    .orderBy(asc(signer.orderIndex));
  return {
    documentName: doc.name,
    recipients: awaitingSigners(
      signers,
      doc.signingMode === "sequential",
      excludeSignerId,
    ),
  };
};
