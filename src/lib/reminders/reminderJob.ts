/**
 * Reminder job: periodically email signers who have a document waiting on them.
 * A signer is reminded at most once per interval, only when it is their turn
 * (in sequential mode, only the current signer), and never after they sign.
 */

import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { document, signer } from "../db/schema.ts";
import type { SignatureRequestEmail } from "../email/signatureRequestEmail.ts";

export interface DueReminder {
  signerId: string;
  email: string;
  name: string;
  signToken: string;
  documentName: string;
}

/**
 * Find the signers due for a reminder: pending, active (the current signer in
 * sequential mode, any in parallel), with an email, whose last reminder (or the
 * send time) is older than the interval.
 */
export const findDueReminders = async (
  db: Db,
  now: Date,
  intervalMs: number,
): Promise<DueReminder[]> => {
  const cutoff = new Date(now.getTime() - intervalMs);

  const rows = await db
    .select({
      signerId: signer.id,
      email: signer.email,
      name: signer.name,
      signToken: signer.signToken,
      orderIndex: signer.orderIndex,
      lastReminderAt: signer.lastReminderAt,
      docId: document.id,
      docName: document.name,
      sentAt: document.sentAt,
      signingMode: document.signingMode,
    })
    .from(signer)
    .innerJoin(document, eq(signer.documentId, document.id))
    .where(and(eq(document.status, "sent"), ne(signer.status, "signed")));

  const byDoc = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const list = byDoc.get(row.docId) ?? [];
    list.push(row);
    byDoc.set(row.docId, list);
  }

  const due: DueReminder[] = [];
  for (const list of byDoc.values()) {
    list.sort((a, b) => a.orderIndex - b.orderIndex);
    const first = list[0];
    if (!first) continue;
    const active = first.signingMode === "sequential" ? [first] : list;
    for (const s of active) {
      if (!s.email) continue;
      const baseline = s.lastReminderAt ?? s.sentAt;
      if (baseline && baseline < cutoff) {
        due.push({
          signerId: s.signerId,
          email: s.email,
          name: s.name,
          signToken: s.signToken,
          documentName: s.docName,
        });
      }
    }
  }
  return due;
};

/** Send due reminders and record when each signer was reminded */
export const runReminders = async (
  db: Db,
  baseUrl: string,
  intervalMs: number,
  send: (input: SignatureRequestEmail) => Promise<void>,
): Promise<number> => {
  const due = await findDueReminders(db, new Date(), intervalMs);
  for (const reminder of due) {
    try {
      await send({
        to: reminder.email,
        signerName: reminder.name,
        documentName: reminder.documentName,
        signUrl: `${baseUrl}/sign/${reminder.signToken}`,
      });
      await db
        .update(signer)
        .set({ lastReminderAt: new Date() })
        .where(eq(signer.id, reminder.signerId));
    } catch (err) {
      console.warn("[signet] reminder failed", err);
    }
  }
  return due.length;
};
