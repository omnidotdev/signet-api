import { randomBytes } from "node:crypto";

/**
 * Generate an unguessable capability token.
 *
 * Signer and manage links are authorized by possession of these tokens rather
 * than by an account, so they must be long and random
 */
export const generateToken = (): string => randomBytes(24).toString("base64url");
