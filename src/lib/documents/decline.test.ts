import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createDraft,
  declineByToken,
  getStatus,
  sendDraft,
  signByToken,
} from "./documentService.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const blankPdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("CONTRACT", { x: 72, y: 720, size: 16, font });
  return doc.save();
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

const sent = async (signers: { name: string; accessCode?: string }[]) => {
  const draft = await createDraft(db, {
    name: "Contract",
    pdf: await blankPdf(),
    signers,
    ownerId: "owner-1",
    ownerEmail: "owner@example.com",
  });
  const out = await sendDraft(db, draft.id, draft.manageToken);
  return { draft, out };
};

describe("decline to sign", () => {
  test("voids the document and records the decline with a reason", async () => {
    const { draft, out } = await sent([{ name: "Ada" }, { name: "Grace" }]);
    const token = out?.signers[0]?.signToken as string;

    const result = await declineByToken(db, token, "Terms are unacceptable");
    expect(result.ok).toBe(true);
    expect(result.ownerEmail).toBe("owner@example.com");

    const status = await getStatus(db, draft.id, draft.manageToken);
    expect(status?.status).toBe("voided");
    expect(status?.signers.find((s) => s.name === "Ada")?.status).toBe(
      "declined",
    );
  });

  test("a voided document can no longer be signed", async () => {
    const { out } = await sent([{ name: "Ada" }]);
    const token = out?.signers[0]?.signToken as string;
    await declineByToken(db, token);

    const signed = await signByToken(db, serviceSigner, token, "Ada", {
      consent: true,
    });
    expect(signed.ok).toBe(false);
  });

  test("decline respects the access code", async () => {
    const { out } = await sent([{ name: "Ada", accessCode: "1234" }]);
    const token = out?.signers[0]?.signToken as string;

    expect((await declineByToken(db, token, "no")).error).toBe("locked");
    expect((await declineByToken(db, token, "no", "1234")).ok).toBe(true);
  });

  test("an unknown token cannot be declined", async () => {
    expect((await declineByToken(db, "nope")).error).toBe("not_found");
  });
});
