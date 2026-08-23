// supabase/functions/browserbase-login/index.ts
//
// Managed replacement for the self-hosted login-service (Docker + Xvfb +
// Chromium + noVNC) referenced by src/routes/notebooks/connect.tsx. That
// container was never deployed -- this replaces it with Browserbase's
// hosted Sessions + Contexts + Live View APIs, so there is nothing left
// to self-host for the login flow itself.
//
// How it works:
//   1. /start creates (or reuses) a Browserbase Context scoped to this
//      user, starts a Session bound to that Context, and returns the
//      session's Live View URL -- a real, interactive iframe-able browser
//      the user logs into Google/NotebookLM inside of.
//   2. Browserbase's Context persists cookies/localStorage server-side,
//      encrypted at rest, keyed by an opaque context id. We only ever
//      store that id (in browserbase_contexts), never any cookie or
//      credential material ourselves.
//   3. /complete just confirms the session actually ran and flips the
//      user to "connected" in notebooklm_connections.
//   4. Future automated NotebookLM actions would start a *new* session
//      reusing the same context id (persist: true) to resume the login --
//      that reuse path is not implemented here since nothing in this repo
//      yet drives NotebookLM automation against it; this function only
//      covers capturing and managing the login itself.
//
// UNTESTED against a live Browserbase account -- verify end-to-end with a
// real BROWSERBASE_API_KEY before depending on it in production, same as
// every other "written for review" function already in this repo.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BROWSERBASE_API_KEY = Deno.env.get("BROWSERBASE_API_KEY")!;
const BROWSERBASE_PROJECT_ID = Deno.env.get("BROWSERBASE_PROJECT_ID")!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
}
if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error(
    "Missing BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID -- set these as Supabase edge " +
      "function secrets (free account at browserbase.com, no card required) before /start " +
      "or /complete will work.",
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BROWSERBASE_API = "https://api.browserbase.com/v1";
const NOTEBOOKLM_PURPOSE = "notebooklm";

// This function is called directly from the browser (src/routes/notebooks/
// connect.tsx), so every response — including errors — needs CORS headers,
// and OPTIONS preflights must be answered before any auth check.
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bbHeaders(): Record<string, string> {
  return { "X-BB-API-Key": BROWSERBASE_API_KEY, "Content-Type": "application/json" };
}


async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const jwt = authHeader?.replace(/^Bearer\s+/i, "");
  if (!jwt) return { error: json({ error: "Missing Authorization header" }, 401) };
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) {
    return { error: json({ error: "Invalid or expired session" }, 401) };
  }
  return { user: data.user };
}

// Reuse a stored context id for this user if we have one, otherwise ask
// Browserbase for a new (empty) context and store its id. The context
// itself starts with no saved login the first time -- the user logging in
// during /start's session is what populates it, via persist: true below.
async function getOrCreateContextId(userId: string): Promise<string> {
  const { data: existing } = await supabase
    .from("browserbase_contexts")
    .select("context_id")
    .eq("user_id", userId)
    .eq("purpose", NOTEBOOKLM_PURPOSE)
    .maybeSingle();

  if (existing?.context_id) return existing.context_id;

  const res = await fetch(`${BROWSERBASE_API}/contexts`, {
    method: "POST",
    headers: bbHeaders(),
    body: JSON.stringify({ projectId: BROWSERBASE_PROJECT_ID }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create Browserbase context: ${res.status} ${await res.text()}`);
  }
  const { id: contextId } = (await res.json()) as { id: string };

  const { error } = await supabase
    .from("browserbase_contexts")
    .upsert(
      { user_id: userId, purpose: NOTEBOOKLM_PURPOSE, context_id: contextId },
      { onConflict: "user_id,purpose" },
    );
  if (error) throw new Error(`Failed to store context id: ${error.message}`);

  return contextId;
}

serve(async (req) => {
  // Answer preflights before any auth check, or the browser never even
  // sends the real request.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/browserbase-login/, "") || "/";

  // --- GET /status ---
  // Same response shape as the old notebooklm-connect /status, so the
  // frontend doesn't need to change how it reads this.
  if (req.method === "GET" && path === "/status") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    const { data, error: dbError } = await supabase
      .from("notebooklm_connections")
      .select("status, connected_at, disconnected_at, last_used_at")
      .eq("user_id", user!.id)
      .maybeSingle();

    if (dbError) return json({ error: dbError.message }, 500);

    return json(
      data ?? { status: "disconnected", connected_at: null, disconnected_at: null, last_used_at: null },
    );
  }

  // --- POST /start ---
  // Creates a session bound to the user's persistent context and returns
  // its Live View URL for the frontend to embed in an <iframe>.
  if (req.method === "POST" && path === "/start") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
      return json(
        {
          error:
            "Browserbase is not configured on the server. Add BROWSERBASE_API_KEY and " +
            "BROWSERBASE_PROJECT_ID as secrets, then redeploy this function.",
        },
        503,
      );
    }

    try {
      const contextId = await getOrCreateContextId(user!.id);

      const sessionRes = await fetch(`${BROWSERBASE_API}/sessions`, {
        method: "POST",
        headers: bbHeaders(),
        body: JSON.stringify({
          projectId: BROWSERBASE_PROJECT_ID,
          browserSettings: {
            context: { id: contextId, persist: true },
            viewport: { width: 1280, height: 800 },
          },
          // Free-tier sessions are capped at 15 minutes server-side regardless
          // of this value -- set explicitly so behaviour doesn't depend on
          // whichever default Browserbase applies if the account upgrades.
          timeout: 900,
        }),
      });
      if (!sessionRes.ok) {
        throw new Error(`Failed to create Browserbase session: ${sessionRes.status} ${await sessionRes.text()}`);
      }
      const session = (await sessionRes.json()) as { id: string };

      const debugRes = await fetch(`${BROWSERBASE_API}/sessions/${session.id}/debug`, {
        headers: bbHeaders(),
      });
      if (!debugRes.ok) {
        throw new Error(`Failed to fetch live view URL: ${debugRes.status} ${await debugRes.text()}`);
      }
      const debug = (await debugRes.json()) as {
        debuggerFullscreenUrl?: string;
        debuggerUrl?: string;
        pages?: Array<{ debuggerFullscreenUrl?: string; debuggerUrl?: string }>;
      };
      // Browserbase has shipped this payload in a couple of shapes; prefer the
      // fullscreen (chrome-less) URL, then the plain one, then the first page's.
      const liveViewUrl =
        debug.debuggerFullscreenUrl ??
        debug.debuggerUrl ??
        debug.pages?.[0]?.debuggerFullscreenUrl ??
        debug.pages?.[0]?.debuggerUrl;
      if (!liveViewUrl) {
        throw new Error("Browserbase returned no live view URL for this session.");
      }

      return json({ sessionId: session.id, liveViewUrl });
    } catch (err) {
      console.error("browserbase-login /start failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // --- POST /complete  { sessionId } ---
  // Confirms the session actually exists/ran, then marks the user
  // connected. The login itself is already saved -- Browserbase persists
  // it into the context automatically because /start set persist: true.
  if (req.method === "POST" && path === "/complete") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    const { sessionId } = await req.json().catch(() => ({}));
    if (!sessionId) {
      return json({ error: "sessionId is required" }, 400);
    }

    try {
      const res = await fetch(`${BROWSERBASE_API}/sessions/${sessionId}`, { headers: bbHeaders() });
      if (!res.ok) {
        throw new Error(`Could not verify Browserbase session: ${res.status} ${await res.text()}`);
      }

      const { error: upsertError } = await supabase.from("notebooklm_connections").upsert(
        {
          user_id: user!.id,
          // Not a secret -- just a human-readable label for the status table,
          // matching the shape the existing notebooklm-connect function wrote.
          // The actual login lives in Browserbase's Context, referenced by
          // browserbase_contexts.context_id.
          vault_secret_name: `browserbase_context:${NOTEBOOKLM_PURPOSE}`,
          connected_at: new Date().toISOString(),
          disconnected_at: null,
          status: "connected",
        },
        { onConflict: "user_id" },
      );
      if (upsertError) throw new Error(upsertError.message);

      return json({ ok: true });
    } catch (err) {
      console.error("browserbase-login /complete failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // --- POST /disconnect ---
  // Deletes the Browserbase Context server-side (irreversible per
  // Browserbase's own docs) plus the local context_id row, and marks the
  // connection disconnected. This is the real "forget my login" action.
  if (req.method === "POST" && path === "/disconnect") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    try {
      const { data: existing } = await supabase
        .from("browserbase_contexts")
        .select("context_id")
        .eq("user_id", user!.id)
        .eq("purpose", NOTEBOOKLM_PURPOSE)
        .maybeSingle();

      if (existing?.context_id && BROWSERBASE_API_KEY) {
        const delRes = await fetch(`${BROWSERBASE_API}/contexts/${existing.context_id}`, {
          method: "DELETE",
          headers: bbHeaders(),
        });
        // A 404 here just means it's already gone -- fine. Anything else is
        // worth logging but shouldn't block clearing our own records.
        if (!delRes.ok && delRes.status !== 404) {
          console.error("Failed to delete Browserbase context:", delRes.status, await delRes.text());
        }
      }

      await supabase
        .from("browserbase_contexts")
        .delete()
        .eq("user_id", user!.id)
        .eq("purpose", NOTEBOOKLM_PURPOSE);

      await supabase
        .from("notebooklm_connections")
        .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
        .eq("user_id", user!.id);

      return json({ ok: true });
    } catch (err) {
      console.error("browserbase-login /disconnect failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
});
