import { beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { signer } from "../db/schema.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import { awaitingSigners, pendingCancellation } from "./cancellation.ts";
import {
  createMultiSignerRequest,
  declineByToken,
  signByToken,
} from "./documentService.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const pdf = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const request = async (signingMode: "parallel" | "sequential") =>
  createMultiSignerRequest(db, {
    name: "Operating agreement",
    pdf: await pdf(),
    signers: [
      { name: "Ada", email: "ada@example.com" },
      { name: "Grace", email: "grace@example.com" },
      { name: "Linus" },
    ],
    signingMode,
    ownerId: "owner-1",
  });

const signersOf = (id: string) =>
  db
    .select()
    .from(signer)
    .where(eq(signer.documentId, id))
    .orderBy(asc(signer.orderIndex));

describe("who is told a request was canceled", () => {
  test("in parallel signing, every unsigned signer with an email", async () => {
    const req = await request("parallel");
    const { documentName, recipients } = await pendingCancellation(db, req.id);
    expect(documentName).toBe("Operating agreement");
    expect(recipients.map((r) => r.email)).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
  });

  test("in order, only the signer whose turn it is has a link to lose", async () => {
    const req = await request("sequential");
    expect(
      (await pendingCancellation(db, req.id)).recipients.map((r) => r.name),
    ).toEqual(["Ada"]);

    const [ada] = await signersOf(req.id);
    await signByToken(db, serviceSigner, ada?.signToken as string, "Ada", {
      consent: true,
    });
    // Ada is done; Grace was sent the request next
    expect(
      (await pendingCancellation(db, req.id)).recipients.map((r) => r.name),
    ).toEqual(["Grace"]);
  });

  test("a decline tells the other waiting signers, not the one who declined", async () => {
    const req = await request("parallel");
    const [ada] = await signersOf(req.id);
    const result = await declineByToken(db, ada?.signToken as string, "no");
    expect(result.ok).toBe(true);
    expect(result.canceled?.map((r) => r.email)).toEqual(["grace@example.com"]);
    // and once voided, there is no one left to tell
    expect((await pendingCancellation(db, req.id)).recipients).toEqual([]);
  });

  test("a draft was never sent, so no one is told", async () => {
    const draft = await createMultiSignerRequest(db, {
      name: "Draft",
      pdf: await pdf(),
      signers: [{ name: "Ada", email: "ada@example.com" }],
      ownerId: "owner-1",
      draft: true,
    });
    expect((await pendingCancellation(db, draft.id)).recipients).toEqual([]);
  });

  test("a signer who already opened a later turn's link is told too", () => {
    const rows = [
      { id: "a", name: "A", email: "a@x", status: "pending", orderIndex: 0 },
      { id: "b", name: "B", email: "b@x", status: "viewed", orderIndex: 1 },
      { id: "c", name: "C", email: "c@x", status: "pending", orderIndex: 2 },
    ];
    expect(awaitingSigners(rows, true).map((r) => r.name)).toEqual(["A", "B"]);
  });
});
