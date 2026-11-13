/**
 * Signed session and OAuth-transaction cookies. The session holds the
 * authenticated sender (Gatekeeper subject, email, name); the transaction
 * cookie carries the short-lived OIDC state/nonce/PKCE verifier across the
 * authorize redirect. Both are HS256 JWTs signed with the session secret, so
 * nothing trusts cookie contents that were not minted here.
 */

import { jwtVerify, SignJWT } from "jose";

const ALG = "HS256";
const encoder = new TextEncoder();
const key = (secret: string) => encoder.encode(secret);

/** A workspace (Gatekeeper organization) the sender belongs to */
export interface Workspace {
  id: string;
  slug?: string;
  name?: string;
}

/** The authenticated sender carried in the session cookie */
export interface Session {
  sub: string;
  email: string;
  name?: string;
  /** active workspace id, stamped on new documents and scoping the dashboard */
  organizationId?: string;
  /** every workspace the sender belongs to, for the switcher and access checks */
  workspaces?: Workspace[];
  /**
   * set when the request authenticated with a managed API key rather than an
   * interactive session; key management itself refuses such sessions
   */
  apiKeyId?: string;
}

/** The in-flight OIDC login carried in the transaction cookie */
export interface OAuthTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

/** Sign a session cookie value, valid for the given lifetime (default 7 days) */
export const signSession = (
  session: Session,
  secret: string,
  expiration: string | number = "7d",
): Promise<string> =>
  new SignJWT({
    email: session.email,
    name: session.name,
    organizationId: session.organizationId,
    workspaces: session.workspaces,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(session.sub)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(key(secret));

/** Verify a session cookie value, or null when missing, invalid, or expired */
export const verifySession = async (
  token: string | undefined,
  secret: string,
): Promise<Session | null> => {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: [ALG],
    });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : "",
      name: typeof payload.name === "string" ? payload.name : undefined,
      organizationId:
        typeof payload.organizationId === "string"
          ? payload.organizationId
          : undefined,
      workspaces: Array.isArray(payload.workspaces)
        ? (payload.workspaces as Workspace[])
        : undefined,
    };
  } catch {
    return null;
  }
};

/** Sign the short-lived OAuth transaction cookie (10 minutes) */
export const signTransaction = (
  tx: OAuthTransaction,
  secret: string,
): Promise<string> =>
  new SignJWT({ ...tx })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key(secret));

/** Verify the OAuth transaction cookie, or null when invalid or expired */
export const verifyTransaction = async (
  token: string | undefined,
  secret: string,
): Promise<OAuthTransaction | null> => {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: [ALG],
    });
    const { state, nonce, verifier, returnTo } = payload as Record<
      string,
      unknown
    >;
    if (
      typeof state !== "string" ||
      typeof nonce !== "string" ||
      typeof verifier !== "string" ||
      typeof returnTo !== "string"
    )
      return null;
    return { state, nonce, verifier, returnTo };
  } catch {
    return null;
  }
};
