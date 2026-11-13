import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { signatureEvent, signer } from "../db/schema.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createMultiSignerRequest,
  ensureSignerOtp,
  signByToken,
  verificationStateFor,
  verifySignerOtp,
} from "./documentService.ts";
import { hashOtpCode } from "./otp.ts";

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

const sendWithVerification = async (
  level: "none" | "email_otp",
  email: string | null = "ada@example.com",
): Promise<string> => {
  const req = await createMultiSignerRequest(db, {
    name: "Agreement",
    pdf: await blankPdf(),
    signers: [{ name: "Ada Lovelace", email: email ?? undefined }],
    verificationLevel: level,
  });
  return req.signers[0]?.signToken as string;
};

/** Plant a known, unexpired code against the signer so verify can be driven */
const plantCode = async (token: string, code: string): Promise<void> => {
  await db
    .update(signer)
    .set({
      otpCodeHash: await hashOtpCode(code),
      otpExpiresAt: new Date(Date.now() + 60_000),
      otpAttempts: 0,
      otpVerifiedAt: null,
    })
    .where(eq(signer.signToken, token));
};

describe("verification state", () => {
  test("email_otp signer with an email requires verification", async () => {
    const token = await sendWithVerification("email_otp");
    const state = await verificationStateFor(db, token);
    expect(state?.required).toBe(true);
    expect(state?.verified).toBe(false);
    expect(state?.maskedEmail).toBe("ad***@example.com");
  });

  test("a document with no verification does not require it", async () => {
    const token = await sendWithVerification("none");
    const state = await verificationStateFor(db, token);
    expect(state?.required).toBe(false);
  });

  test("a signer with no email cannot be OTP-gated", async () => {
    const token = await sendWithVerification("email_otp", null);
    const state = await verificationStateFor(db, token);
    expect(state?.required).toBe(false);
  });
});

describe("signing gate", () => {
  test("signing is refused until the signer verifies", async () => {
    const token = await sendWithVerification("email_otp");
    const blocked = await signByToken(
      db,
      serviceSigner,
      token,
      "Ada Lovelace",
      {
        consent: true,
      },
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("verification_required");

    await plantCode(token, "123456");
    const verified = await verifySignerOtp(db, token, "123456");
    expect(verified.ok).toBe(true);

    const signed = await signByToken(db, serviceSigner, token, "Ada Lovelace", {
      consent: true,
    });
    expect(signed.ok).toBe(true);
  });

  test("the signed event records the verification method", async () => {
    const token = await sendWithVerification("email_otp");
    await plantCode(token, "123456");
    await verifySignerOtp(db, token, "123456");
    await signByToken(db, serviceSigner, token, "Ada Lovelace", {
      consent: true,
    });

    const events = await db.select().from(signatureEvent);
    const signed = events.find((e) => e.type === "document.signed");
    const data = signed?.data as {
      verification?: { method?: string } | null;
    };
    expect(data.verification?.method).toBe("email_otp");
    expect(events.some((e) => e.type === "identity.verified")).toBe(true);
  });
});

describe("code verification", () => {
  test("a wrong code is rejected and counted", async () => {
    const token = await sendWithVerification("email_otp");
    await plantCode(token, "123456");
    const bad = await verifySignerOtp(db, token, "000000");
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("invalid_code");
    const [row] = await db
      .select({ otpAttempts: signer.otpAttempts })
      .from(signer)
      .where(eq(signer.signToken, token));
    expect(row?.otpAttempts).toBe(1);
  });

  test("the correct code verifies and is sticky", async () => {
    const token = await sendWithVerification("email_otp");
    await plantCode(token, "424242");
    const ok = await verifySignerOtp(db, token, "424242");
    expect(ok.ok).toBe(true);
    const state = await verificationStateFor(db, token);
    expect(state?.verified).toBe(true);
    // the code is burned after use
    const [row] = await db
      .select({ otpCodeHash: signer.otpCodeHash })
      .from(signer)
      .where(eq(signer.signToken, token));
    expect(row?.otpCodeHash).toBeNull();
  });

  test("an expired code is rejected", async () => {
    const token = await sendWithVerification("email_otp");
    await db
      .update(signer)
      .set({
        otpCodeHash: await hashOtpCode("123456"),
        otpExpiresAt: new Date(Date.now() - 1000),
        otpAttempts: 0,
      })
      .where(eq(signer.signToken, token));
    const res = await verifySignerOtp(db, token, "123456");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("expired");
  });

  test("too many wrong attempts locks the code", async () => {
    const token = await sendWithVerification("email_otp");
    await db
      .update(signer)
      .set({
        otpCodeHash: await hashOtpCode("123456"),
        otpExpiresAt: new Date(Date.now() + 60_000),
        otpAttempts: 5,
      })
      .where(eq(signer.signToken, token));
    const res = await verifySignerOtp(db, token, "123456");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("too_many_attempts");
  });
});

describe("issuing codes", () => {
  test("ensureSignerOtp plants a live code for a required signer", async () => {
    const token = await sendWithVerification("email_otp");
    const res = await ensureSignerOtp(db, token);
    expect(res.ok).toBe(true);
    const [row] = await db
      .select({
        otpCodeHash: signer.otpCodeHash,
        otpExpiresAt: signer.otpExpiresAt,
      })
      .from(signer)
      .where(eq(signer.signToken, token));
    expect(row?.otpCodeHash).not.toBeNull();
    expect(row?.otpExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  test("ensureSignerOtp is a no-op when verification is not required", async () => {
    const token = await sendWithVerification("none");
    const res = await ensureSignerOtp(db, token);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_required");
  });
});
