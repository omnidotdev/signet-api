/**
 * Auth configuration and the graceful-degradation gate. Signet uses Gatekeeper
 * (the Omni OIDC provider) for optional sender accounts. With the OIDC client
 * env unset, auth is disabled: the login UI is hidden and the anonymous
 * send-for-signature flow is unchanged.
 */

export interface AuthConfig {
  /** OIDC issuer base, e.g. https://identity.omni.dev */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** HMAC secret for the signed session and transaction cookies */
  sessionSecret: string;
  /** absolute callback URL registered with the OIDC client */
  redirectUri: string;
}

const DEFAULT_ISSUER = "https://identity.omni.dev";

/**
 * Build the auth config from env, or null when auth is not configured. Requires
 * a client id, client secret, and session secret to be present together.
 */
export const loadAuthConfig = (baseUrl: string): AuthConfig | null => {
  const clientId = process.env.SIGNET_OAUTH_CLIENT_ID;
  const clientSecret = process.env.SIGNET_OAUTH_CLIENT_SECRET;
  const sessionSecret = process.env.SIGNET_SESSION_SECRET;

  if (!clientId || !clientSecret || !sessionSecret) return null;

  return {
    issuer: process.env.SIGNET_OIDC_ISSUER ?? DEFAULT_ISSUER,
    clientId,
    clientSecret,
    sessionSecret,
    redirectUri: `${baseUrl}/auth/callback`,
  };
};
