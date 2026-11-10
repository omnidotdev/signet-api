/**
 * A minimal OIDC Authorization Code + PKCE client for Gatekeeper. Endpoints are
 * discovered at runtime from the issuer's well-known document, the code is
 * exchanged server-to-server, and the returned id_token is validated against
 * the issuer's JWKS before any claim is trusted.
 */

import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthConfig } from "./config.ts";
import type { Session } from "./session.ts";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, Promise<Discovery>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Fetch and cache the issuer's OIDC discovery document */
const discover = (issuer: string): Promise<Discovery> => {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;
  const pending = fetch(`${issuer}/.well-known/openid-configuration`)
    .then((res) => {
      if (!res.ok) throw new Error(`discovery ${res.status}`);
      return res.json() as Promise<Discovery>;
    })
    .catch((err) => {
      discoveryCache.delete(issuer);
      throw err;
    });
  discoveryCache.set(issuer, pending);
  return pending;
};

/** base64url-encoded random token for state and nonce */
export const randomToken = (): string => randomBytes(16).toString("base64url");

/** A PKCE verifier and its S256 challenge */
export const createPkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

/** Build the authorize URL to redirect the browser to */
export const buildAuthorizeUrl = async (
  config: AuthConfig,
  params: { state: string; nonce: string; challenge: string },
): Promise<string> => {
  const discovery = await discover(config.issuer);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  // `organization` adds the user's workspace memberships to userinfo
  url.searchParams.set("scope", "openid email profile organization");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

/** Exchange an authorization code for tokens at the token endpoint */
const exchangeCode = async (
  config: AuthConfig,
  code: string,
  verifier: string,
): Promise<{ id_token?: string; access_token?: string }> => {
  const discovery = await discover(config.issuer);
  const basic = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString("base64");
  const res = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}`);
  return res.json() as Promise<{ id_token?: string; access_token?: string }>;
};

/** A workspace (Gatekeeper organization) the sender belongs to */
interface UserinfoOrg {
  id: string;
  type?: string;
}

/**
 * Read the organizations claim from a userinfo body. The claim is namespaced
 * (e.g. `https://manifold.omni.dev/@omni/claims/organizations`), so match by the
 * key suffix rather than hardcoding the namespace.
 */
const readOrgs = (body: Record<string, unknown>): UserinfoOrg[] => {
  const entry = Object.entries(body).find(([k]) =>
    k.endsWith("/organizations"),
  );
  const value = entry?.[1];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (o): o is UserinfoOrg =>
      typeof o === "object" &&
      o !== null &&
      typeof (o as UserinfoOrg).id === "string",
  );
};

/** Pull email, name, and workspace memberships from userinfo */
const fetchUserinfo = async (
  config: AuthConfig,
  accessToken: string,
): Promise<{ email?: string; name?: string; organizations: UserinfoOrg[] }> => {
  const discovery = await discover(config.issuer);
  const res = await fetch(discovery.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { organizations: [] };
  const body = (await res.json()) as Record<string, unknown> & {
    email?: string;
    name?: string;
  };
  return {
    email: body.email,
    name: body.name,
    organizations: readOrgs(body),
  };
};

/** The active workspace: the sender's personal org, else the first membership */
const activeOrg = (orgs: UserinfoOrg[]): string | undefined =>
  (orgs.find((o) => o.type === "personal") ?? orgs[0])?.id;

/**
 * Complete the callback: exchange the code, validate the id_token against the
 * issuer's JWKS, check the nonce, and return the authenticated session.
 */
export const completeLogin = async (
  config: AuthConfig,
  code: string,
  verifier: string,
  expectedNonce: string,
): Promise<Session> => {
  const tokens = await exchangeCode(config, code, verifier);
  if (!tokens.id_token) throw new Error("no id_token in token response");

  const discovery = await discover(config.issuer);
  let jwks = jwksCache.get(config.issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    jwksCache.set(config.issuer, jwks);
  }

  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: discovery.issuer,
    audience: config.clientId,
  });
  if (!payload.sub) throw new Error("id_token missing sub");
  if (expectedNonce && payload.nonce !== expectedNonce)
    throw new Error("nonce mismatch");

  let email = typeof payload.email === "string" ? payload.email : "";
  let name = typeof payload.name === "string" ? payload.name : undefined;
  let organizationId: string | undefined;
  if (tokens.access_token) {
    const info = await fetchUserinfo(config, tokens.access_token);
    email = email || (info.email ?? "");
    name = name ?? info.name;
    organizationId = activeOrg(info.organizations);
  }

  return { sub: payload.sub, email, name, organizationId };
};
