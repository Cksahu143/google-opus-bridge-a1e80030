import { createFileRoute } from "@tanstack/react-router";

/**
 * Google OAuth redirect target.
 *
 * Google calls this route directly, so it must remain public.
 * The OAuth state itself is validated and consumed atomically by
 * the server-side Supabase RPC.
 */
export const Route = createFileRoute(
  "/api/public/google/callback",
)({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);

        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (error) {
          return fail(`Google denied the request: ${error}`);
        }

        if (!code || !state) {
          return fail(
            "Missing code or state in the Google callback.",
          );
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        /*
         * Atomically validate and consume the OAuth state.
         *
         * The database function:
         * - checks the state exists
         * - checks it is not older than 10 minutes
         * - returns the user_id/code_verifier/redirect_to
         * - deletes the state in the same transaction
         *
         * This prevents the same OAuth state from being reused.
         */
        let oauthState: unknown;
        let stateError: unknown;

        try {
          const result = await supabaseAdmin.rpc("consume_oauth_state", {
            p_state: state,
          });
          oauthState = result.data;
          stateError = result.error;
        } catch (cause) {
          return fail(
            diagnostic(
              "OAuth state RPC",
              cause,
            ),
          );
        }

        if (stateError) {
          return fail(
            diagnostic("OAuth state RPC", stateError),
          );
        }

        if (
          !oauthState ||
          typeof oauthState !== "object" ||
          Array.isArray(oauthState)
        ) {
          return fail(
            "Google connection diagnostic: OAuth state not found/expired — the sign-in state was missing or expired.",
          );
        }

        const statePayload = oauthState as Record<string, unknown>;
        const userId =
          typeof statePayload["user_id"] === "string"
            ? statePayload["user_id"]
            : null;

        const codeVerifier =
          typeof statePayload["code_verifier"] === "string"
            ? statePayload["code_verifier"]
            : null;

        const redirectTo =
          typeof statePayload["redirect_to"] === "string"
            ? statePayload["redirect_to"]
            : "/";

        if (!userId || !codeVerifier) {
          return fail(
            "Google connection diagnostic: OAuth state payload failed — required state fields were missing.",
          );
        }

        const {
          exchangeCodeForTokens,
          fetchUserInfo,
        } = await import("@/lib/nexus/oauth.server");

        const { callbackUrlFor } = await import(
          "@/lib/nexus/connect.server"
        );

        const { GoogleConnectionSaveError, saveConnection } = await import(
          "@/lib/nexus/connections.server"
        );

        let tokens;
        try {
          tokens = await exchangeCodeForTokens({
            code,
            redirectUri: callbackUrlFor(request.url),
            codeVerifier,
          });
        } catch (cause) {
          return fail(diagnostic("Google authorization-code exchange", cause));
        }

        let profile;
        try {
          profile = await fetchUserInfo(tokens.access_token);
        } catch (cause) {
          return fail(diagnostic("Google profile/user-info fetch", cause));
        }

        try {
          await saveConnection({
            userId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            expiresInSeconds: tokens.expires_in,
            scopes: tokens.scope ? tokens.scope.split(" ") : [],
            googleEmail: profile.email,
            googleSub: profile.sub,
          });
        } catch (cause) {
          if (cause instanceof GoogleConnectionSaveError) {
            return fail(
              diagnostic(
                cause.stage === "vault_storage"
                  ? "Vault token storage"
                  : "Google connection metadata persistence",
                cause,
              ),
            );
          }

          return fail(diagnostic("Google connection metadata persistence", cause));
        }

        return new Response(null, {
          status: 302,
          headers: {
            location: `${redirectTo}?google=connected`,
          },
        });
      },
    },
  },
});

function fail(message: string) {
  return new Response(null, {
    status: 302,
    headers: {
      location: `/?google=error&message=${encodeURIComponent(
        message,
      )}`,
    },
  });
}

function diagnostic(stage: string, cause: unknown): string {
  return `Google connection diagnostic: ${stage} failed — ${safeErrorMessage(cause)}`;
}

function safeErrorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : "Unexpected error.";
  const safe = raw
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:code|state|access_token|refresh_token|client_secret)=[^&\s]+)/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(?:access_token|refresh_token|authorization_code|client_secret|id_token)\s*([:=])\s*[^,\s]+/gi,
      (_match, separator: string) => `[credential redacted]${separator}[redacted]`,
    )
    .replace(
      /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();

  return safe.slice(0, 240) || "Unexpected error.";
}
