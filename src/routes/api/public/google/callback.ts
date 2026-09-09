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

        const {
          supabaseAdmin,
        } = await import(
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
        const { data: oauthState, error: stateError } =
          await supabaseAdmin.rpc("consume_oauth_state", {
            p_state: state,
          });

        if (stateError) {
          return fail(
            "Unable to validate the Google sign-in state.",
          );
        }

        if (
          !oauthState ||
          typeof oauthState !== "object" ||
          Array.isArray(oauthState)
        ) {
          return fail(
            "This sign-in link expired. Start the connection again.",
          );
        }

        const userId =
          typeof oauthState.user_id === "string"
            ? oauthState.user_id
            : null;

        const codeVerifier =
          typeof oauthState.code_verifier === "string"
            ? oauthState.code_verifier
            : null;

        const redirectTo =
          typeof oauthState.redirect_to === "string"
            ? oauthState.redirect_to
            : "/";

        if (!userId || !codeVerifier) {
          return fail(
            "Invalid OAuth state. Start the connection again.",
          );
        }

        const {
          exchangeCodeForTokens,
          fetchUserInfo,
        } = await import("@/lib/nexus/oauth.server");

        const { callbackUrlFor } = await import(
          "@/lib/nexus/connect.server"
        );

        const { saveConnection } = await import(
          "@/lib/nexus/connections.server"
        );

        try {
          const tokens = await exchangeCodeForTokens({
            code,
            redirectUri: callbackUrlFor(request.url),
            codeVerifier,
          });

          const profile = await fetchUserInfo(
            tokens.access_token,
          );

          await saveConnection({
            userId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresInSeconds: tokens.expires_in,
            scopes: tokens.scope
              ? tokens.scope.split(" ")
              : [],
            googleEmail: profile.email,
            googleSub: profile.sub,
          });
        } catch (cause) {
          return fail(
            cause instanceof Error
              ? cause.message
              : "Google connection failed.",
          );
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
