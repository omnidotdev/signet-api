import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { document } from "../db/schema.ts";
import {
  createDraft,
  sendDraft,
  signByToken,
} from "../documents/documentService.ts";
import type { SignatureRequestEmail } from "../email/signatureRequestEmail.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import { findDueReminders, runReminders } from "./reminderJob.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const DAY = 24 * 60 * 60 * 1000;
const tinyPdf = async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

/** Backdate a document's sent time so reminders come due */
const backdate = (id: string, ms: number) =>
  db
    .update(document)
    .set({ sentAt: new Date(Date.now() - ms) })
    .where(eq(document.id, id));

describe("reminders", () => {
  test("no reminders until the interval passes", async () => {
    const draft = await createDraft(db, {
      name: "D",
      pdf: await tinyPdf(),
      signers: [{ name: "Ada", email: "ada@example.com" }],
    });
    await sendDraft(db, draft.id, draft.manageToken);
    expect(await findDueReminders(db, new Date(), DAY)).toHaveLength(0);
  });

  test("reminds a pending signer with an email once the interval passes", async () => {
    const draft = await createDraft(db, {
      name: "D",
      pdf: await tinyPdf(),
      signers: [
        { name: "Ada", email: "ada@example.com" },
        { name: "No Email" },
      ],
    });
    await sendDraft(db, draft.id, draft.manageToken);
    await backdate(draft.id, 2 * DAY);

    const due = await findDueReminders(db, new Date(), DAY);
    expect(due).toHaveLength(1);
    expect(due[0]?.email).toBe("ada@example.com");
  });

  test("sequential mode only reminds the current signer", async () => {
    const draft = await createDraft(db, {
      name: "D",
      pdf: await tinyPdf(),
      signers: [
        { name: "First", email: "first@example.com" },
        { name: "Second", email: "second@example.com" },
      ],
      signingMode: "sequential",
    });
    await sendDraft(db, draft.id, draft.manageToken);
    await backdate(draft.id, 2 * DAY);

    const due = await findDueReminders(db, new Date(), DAY);
    expect(due).toHaveLength(1);
    expect(due[0]?.email).toBe("first@example.com");
  });

  test("runReminders sends, records, and does not repeat within the interval", async () => {
    const draft = await createDraft(db, {
      name: "D",
      pdf: await tinyPdf(),
      signers: [{ name: "Ada", email: "ada@example.com" }],
    });
    await sendDraft(db, draft.id, draft.manageToken);
    await backdate(draft.id, 2 * DAY);

    const sent: SignatureRequestEmail[] = [];
    const send = async (input: SignatureRequestEmail) => {
      sent.push(input);
    };
    expect(await runReminders(db, "https://x", DAY, send)).toBe(1);
    expect(sent).toHaveLength(1);
    // lastReminderAt is now recent, so a second sweep sends nothing
    expect(await runReminders(db, "https://x", DAY, send)).toBe(0);
  });

  test("a signed signer is not reminded", async () => {
    const draft = await createDraft(db, {
      name: "D",
      pdf: await tinyPdf(),
      signers: [{ name: "Ada", email: "ada@example.com" }],
    });
    const sentRes = await sendDraft(db, draft.id, draft.manageToken);
    await backdate(draft.id, 2 * DAY);
    await signByToken(
      db,
      serviceSigner,
      sentRes?.signers[0]?.signToken as string,
      undefined,
      { consent: true },
    );
    expect(await findDueReminders(db, new Date(), DAY)).toHaveLength(0);
  });
});
