import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { document, signer } from "../db/schema.ts";

/**
 * Resolve the signer on an in-flight document whose email matches the signed-in
 * user, so the sender (or any recipient who holds an account) can sign in-app
 * without the emailed capability link. Returns that signer's sign token, which
 * the caller feeds to the existing token-based signing flow. Returns null when
 * the user is not a signer on this document, the document is not out for
 * signature, or the signer has already signed or declined.
 */
export const resolveMySignToken = async (
  db: Db,
  documentId: string,
  email: string,
): Promise<string | null> => {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const rows = await db
    .select({
      signToken: signer.signToken,
      email: signer.email,
      status: signer.status,
    })
    .from(signer)
    .innerJoin(document, eq(signer.documentId, document.id))
    .where(and(eq(signer.documentId, documentId), eq(document.status, "sent")));
  const mine = rows.find(
    (r) =>
      (r.email ?? "").trim().toLowerCase() === normalized &&
      r.status !== "signed" &&
      r.status !== "declined",
  );
  return mine?.signToken ?? null;
};
