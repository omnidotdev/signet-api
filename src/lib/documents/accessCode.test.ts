import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createDraft,
  saveFields,
  sendDraft,
  signByToken,
  verifySignerAccess,
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

const sentWithCode = async (code: string) => {
  const draft = await createDraft(db, {
    name: "Contract",
    pdf: await blankPdf(),
    signers: [{ name: "Ada", accessCode: code }],
  });
  const data = await import("./documentService.ts").then((m) =>
    m.getEditorData(db, draft.id, draft.manageToken),
  );
  await saveFields(db, draft.id, draft.manageToken, [
    {
      signerId: data?.signers[0]?.id ?? null,
      type: "signature",
      page: 1,
      x: 100,
      y: 400,
      width: 160,
      height: 20,
    },
  ]);
  const sent = await sendDraft(db, draft.id, draft.manageToken);
  return sent?.signers[0]?.signToken as string;
};

describe("signer access code", () => {
  test("locks the document until the right code is given", async () => {
    const token = await sentWithCode("7788");
    expect(await verifySignerAccess(db, token)).toBe("locked");
    expect(await verifySignerAccess(db, token, "0000")).toBe("locked");
    expect(await verifySignerAccess(db, token, " 7788 ")).toBe("ok");
  });

  test("unknown token is not found", async () => {
    expect(await verifySignerAccess(db, "nope", "7788")).toBe("not_found");
  });

  test("signing is refused without the code and accepted with it", async () => {
    const token = await sentWithCode("secret-code");

    const refused = await signByToken(
      db,
      serviceSigner,
      token,
      "Ada Lovelace",
      {
        signatureImage: null,
        consent: true,
      },
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe("locked");

    const accepted = await signByToken(
      db,
      serviceSigner,
      token,
      "Ada Lovelace",
      { accessCode: "secret-code", consent: true },
    );
    expect(accepted.ok).toBe(true);
  });

  test("a signer with no code is open", async () => {
    const draft = await createDraft(db, {
      name: "Open",
      pdf: await blankPdf(),
      signers: [{ name: "Grace" }],
    });
    const sent = await sendDraft(db, draft.id, draft.manageToken);
    const token = sent?.signers[0]?.signToken as string;
    expect(await verifySignerAccess(db, token)).toBe("ok");
  });
});
