import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import { createDraft, sendDraft, signByToken } from "./documentService.ts";
import { signNotices } from "./signNotices.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const blankPdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

const BASE = "https://signet.example";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const sendThree = async (
  ownerEmail: string,
  signingMode: "parallel" | "sequential" = "parallel",
) => {
  const draft = await createDraft(db, {
    name: "Lease",
    pdf: await blankPdf(),
    ownerId: "owner",
    ownerEmail,
    signingMode,
    signers: [
      { name: "Ada", email: "ada@example.com" },
      { name: "Grace", email: "grace@example.com" },
      { name: "Linus", email: "linus@example.com" },
    ],
  });
  const sent = await sendDraft(db, draft.id, draft.manageToken);
  return (sent?.signers ?? []).map((s) => s.signToken);
};

const sign = (token: string | undefined, name: string) =>
  signByToken(db, serviceSigner, token as string, name, { consent: true });

const summary = (notices: ReturnType<typeof signNotices>) =>
  notices.map((n) => `${n.kind}:${n.email.to}`).sort();

describe("emails a signature sets off", () => {
  test("a signer who is not last gets a receipt and the sender hears who is left", async () => {
    const [a] = await sendThree("owner@example.com");
    const notices = signNotices(await sign(a, "Ada"), BASE);

    expect(summary(notices)).toEqual([
      "progress:owner@example.com",
      "receipt:ada@example.com",
    ]);
    const progress = notices.find((n) => n.kind === "progress");
    expect(
      progress?.kind === "progress" ? progress.email.waitingOn : [],
    ).toEqual(["Grace", "Linus"]);
  });

  test("the last signature sends every signer and the sender the finished document", async () => {
    const [a, b, c] = await sendThree("owner@example.com");
    await sign(a, "Ada");
    await sign(b, "Grace");
    const notices = signNotices(await sign(c, "Linus"), BASE);

    expect(summary(notices)).toEqual([
      "completion:ada@example.com",
      "completion:grace@example.com",
      "completion:linus@example.com",
      "completion:owner@example.com",
    ]);
  });

  test("a sender who also signs gets one completion email, and no progress note for their own signature", async () => {
    const [a, b] = await sendThreeWithOwnerSigning();
    const first = signNotices(await sign(a, "Owner"), BASE);
    expect(summary(first)).toEqual(["receipt:Owner@Example.com"]);

    const last = signNotices(await sign(b, "Grace"), BASE);
    expect(summary(last)).toEqual([
      "completion:Owner@Example.com",
      "completion:grace@example.com",
    ]);
  });

  test("in order, the next signer gets their link along with the receipt and progress", async () => {
    const [a] = await sendThree("owner@example.com", "sequential");
    const notices = signNotices(await sign(a, "Ada"), BASE);

    expect(summary(notices)).toEqual([
      "progress:owner@example.com",
      "receipt:ada@example.com",
      "request:grace@example.com",
    ]);
  });
});

const sendThreeWithOwnerSigning = async () => {
  const draft = await createDraft(db, {
    name: "Lease",
    pdf: await blankPdf(),
    ownerId: "owner",
    ownerEmail: "owner@example.com",
    signers: [
      { name: "Owner", email: "Owner@Example.com" },
      { name: "Grace", email: "grace@example.com" },
    ],
  });
  const sent = await sendDraft(db, draft.id, draft.manageToken);
  return (sent?.signers ?? []).map((s) => s.signToken);
};
