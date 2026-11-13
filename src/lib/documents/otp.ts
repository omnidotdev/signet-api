import { randomInt } from "node:crypto";

/** Number of digits in a signer's one-time verification code */
export const OTP_LENGTH = 6;

/** How long a one-time code stays valid after it is issued */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** Failed attempts allowed against one code before it is burned */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * Generate a numeric one-time code. Uses a cryptographically strong source and
 * is zero-padded to a fixed length, so every code has the same digit count
 */
export const generateOtpCode = (): string =>
  randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, "0");

/**
 * Hash a one-time code for storage. The code is short and low-entropy, so it is
 * never stored in the clear: a slow hash means a leaked row cannot be reversed
 * before the code expires
 */
export const hashOtpCode = (code: string): Promise<string> =>
  Bun.password.hash(code, { algorithm: "bcrypt", cost: 10 });

/** Verify a submitted code against a stored hash in constant time */
export const verifyOtpCode = (code: string, hash: string): Promise<boolean> =>
  Bun.password.verify(code, hash);

/**
 * Partially mask an email for display on the verification screen, so a signer
 * can confirm where the code was sent without the address being fully exposed
 * to a shoulder-surfer. `ada@example.com` becomes `ad***@example.com`
 */
export const maskEmail = (email: string): string => {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}***${domain}`;
};
