import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { signatureEvent } from "../db/schema.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import { createDraft, sendDraft, signByToken } from "./documentService.ts";

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

const sendToOneSigner = async (): Promise<string> => {
  const draft = await createDraft(db, {
    name: "Agreement",
    pdf: await blankPdf(),
    signers: [{ name: "Ada Lovelace", email: "ada@example.com" }],
  });
  const sent = await sendDraft(db, draft.id, draft.manageToken);
  return sent?.signers[0]?.signToken as string;
};

describe("ESIGN consent gate", () => {
  test("a signature is refused when consent is not affirmed", async () => {
    const token = await sendToOneSigner();
    const result = await signByToken(db, serviceSigner, token, "Ada Lovelace", {
      consent: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("consent_required");
  });

  test("a signature with no options at all is refused", async () => {
    const token = await sendToOneSigner();
    const result = await signByToken(db, serviceSigner, token, "Ada Lovelace");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("consent_required");
  });

  test("the signature is accepted once consent is affirmed", async () => {
    const token = await sendToOneSigner();
    const result = await signByToken(db, serviceSigner, token, "Ada Lovelace", {
      consent: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("audit trail network identity", () => {
  test("records the signer's IP, user-agent, and email on the signed event", async () => {
    const token = await sendToOneSigner();
    const ok = await signByToken(db, serviceSigner, token, "Ada Lovelace", {
      consent: true,
      actor: { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (TestAgent)" },
    });
    expect(ok.ok).toBe(true);

    const events = await db.select().from(signatureEvent);
    const signed = events.find((e) => e.type === "document.signed");
    expect(signed).toBeDefined();
    const data = signed?.data as {
      ip?: string;
      userAgent?: string;
      email?: string;
      consent?: boolean;
    };
    expect(data.ip).toBe("203.0.113.7");
    expect(data.userAgent).toBe("Mozilla/5.0 (TestAgent)");
    expect(data.email).toBe("ada@example.com");
    expect(data.consent).toBe(true);
  });

  test("tolerates a missing actor, recording nulls", async () => {
    const token = await sendToOneSigner();
    const ok = await signByToken(db, serviceSigner, token, "Ada Lovelace", {
      consent: true,
    });
    expect(ok.ok).toBe(true);

    const events = await db.select().from(signatureEvent);
    const signed = events.find((e) => e.type === "document.signed");
    const data = signed?.data as {
      ip: string | null;
      userAgent: string | null;
    };
    expect(data.ip).toBeNull();
    expect(data.userAgent).toBeNull();
  });
});
