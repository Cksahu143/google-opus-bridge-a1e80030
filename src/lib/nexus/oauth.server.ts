import { createHash, randomBytes } from "node:crypto";

import { BASE_SCOPES, uniqueScopes } from "./scopes";
import { NexusError } from "./errors";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export const OAUTH_CALLBACK_PATH = "/api/public/google/callback";

export function googleOAuthConfig() {
  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
  return { clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
}

function requireConfig() {
  const config = googleOAuthConfig();
  if (!config.configured) {
    throw new NexusError(
      "oauth_not_configured",
      "Google OAuth is not configured. Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
      503,
    );
  }
  return config as { clientId: string; clientSecret: string; configured: true };
}

export function createPkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizationUrl(options: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  loginHint?: string;
}): string {
  const { clientId } = requireConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: uniqueScopes(options.scopes).join(" "),
    // offline + consent so a refresh token is always issued (Safari/iPad safe:
    // this is a plain full-page redirect, no desktop process involved).
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
  });
  if (options.loginHint) params.set("login_hint", options.loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
  id_token?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new NexusError(
      "oauth_token_error",
      `Google rejected the token request: ${String(json["error_description"] ?? json["error"] ?? res.status)}`,
      502,
    );
  }
  return json as unknown as GoogleTokenResponse;
}

export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}) {
  const { clientId, clientSecret } = requireConfig();
  return tokenRequest({
    code: params.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code_verifier: params.codeVerifier,
  });
}

export async function refreshAccessToken(refreshToken: string) {
  const { clientId, clientSecret } = requireConfig();
  return tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

export async function fetchUserInfo(accessToken: string) {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new NexusError("userinfo_failed", "Could not read the Google profile", 502);
  return (await res.json()) as { sub: string; email?: string; name?: string; picture?: string };
}

export const IDENTITY_SCOPES = BASE_SCOPES;
