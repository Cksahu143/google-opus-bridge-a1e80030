// supabase/functions/steel-login/index.ts
//
// Replaces browserbase-login as the backend for /notebooks/connect, per
// user-reported slowness and disconnects with Browserbase. Independently
// verified against Steel's own docs (not assumed): sub-second same-region
// session start, and a free tier of 100 browser hours/month with no card.
//
// PERSISTENCE MECHANISM -- corrected from the first version of this file.
// That version guessed at a `/sessions/{id}/export` endpoint returning a
// raw cookie/state blob, stored via Supabase Vault, and flagged that guess
// explicitly as unverified. Checked against Steel's actual docs before
// deploying: there is no such endpoint. The real, documented mechanism is
// the Profiles API -- create a session with `persistProfile: true` to get
// back a `profileId`, then pass that same `profileId` (plus
// `persistProfile: true` again, to keep layering state) into future
// sessions to resume as that logged-in user. Steel persists the actual
// cookies/storage on ITS side, the same trust model Browserbase's Context
// object used -- this app only ever stores the opaque profileId, never
// real session data. That also means Vault is no longer needed for this
// flow at all: the profileId is stored in the existing browserbase_contexts
// table (already RLS'd for exactly this shape: user_id + purpose +
// context_id), just under purpose 'notebooklm_steel' instead of
// 'notebooklm', so both backends can coexist without collision.
//
// KNOWN RISK, carried over deliberately: /type reuses ONE attached CDP
// connection per session via module-level cache rather than
// attaching/detaching per call, because repeated Target.attachToTarget
// cycles on a watched target visibly disrupted Browserbase's Live View
// (confirmed the hard way earlier tonight). This cache does NOT survive a
// cold start -- if this function's Deno isolate gets recycled between
// /start and a later /type call (a real possibility if the user takes a
// while to react), /type will fail with "No active session found" and the
// user has to restart the login. There is no serverless-safe way to
// guarantee a warm isolate; this is a real, known limitation, not a bug
// being silently ignored.
//
// Everything else mirrors browserbase-login's structure:
//   - /start creates (or resumes, via profileId) a session, navigates it
//     to NotebookLM, returns sessionViewerUrl for the frontend iframe.
//     Immediately saves the returned profileId, regardless of whether the
//     user finishes logging in -- harmless if the profile ends up
//     unauthenticated, it just gets reused and built on next attempt.
//   - /type forwards locally-typed text into the remote page's focused
//     field via CDP Input.insertText -- iOS/iPadOS Safari won't raise a
//     keyboard for an element inside a screencast iframe, so the "type
//     into browser" box on the frontend exists regardless of which
//     backend is behind it.
//   - /complete just releases the session and marks notebooklm_connections
//     connected -- no export step needed, the profile already has
//     whatever the user logged into by this point.
//   - /disconnect removes the saved profileId reference and marks
//     notebooklm_connections disconnected.
//   - /status reports connection state from notebooklm_connections (same
//     table browserbase-login used -- this is purely a different login
//     backend for the same feature, no schema change needed there).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STEEL_API_KEY = Deno.env.get("STEEL_API_KEY")!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !STEEL_API_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STEEL_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const STEEL_API = "https://api.steel.dev/v1";
const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const STEEL_PURPOSE = "notebooklm_steel";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function steelHeaders(): Record<string, string> {
  // Confirmed directly from Steel's own auth docs: "When calling the REST
  // API directly, send your key in the steel-api-key header."
  return { "steel-api-key": STEEL_API_KEY, "content-type": "application/json" };
}

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const jwt = authHeader?.replace(/^Bearer\s+/i, "");
  if (!jwt) return { error: json({ error: "Missing Authorization header" }, 401) };
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) return { error: json({ error: "Invalid or expired session" }, 401) };
  return { user: data.user };
}

async function getSavedProfileId(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("browserbase_contexts")
    .select("context_id")
    .eq("user_id", userId)
    .eq("purpose", STEEL_PURPOSE)
    .maybeSingle();
  return (data?.context_id as string | undefined) ?? null;
}

async function saveProfileId(userId: string, profileId: string): Promise<void> {
  await supabase
    .from("browserbase_contexts")
    .upsert(
      { user_id: userId, purpose: STEEL_PURPOSE, context_id: profileId },
      { onConflict: "user_id,purpose" },
    );
}

async function markConnected(userId: string): Promise<void> {
  await supabase.from("notebooklm_connections").upsert(
    {
      user_id: userId,
      vault_secret_name: `steel_profile:${STEEL_PURPOSE}`, // label only, not a secret -- the real state lives in Steel's own Profile, referenced by browserbase_contexts.context_id
      connected_at: new Date().toISOString(),
      disconnected_at: null,
      status: "connected",
    },
    { onConflict: "user_id" },
  );
}

// --- Minimal CDP client -- identical protocol to browserbase-login's,
// just pointed at Steel's websocketUrl instead of Browserbase's
// connectUrl. See that file for the full reasoning on why /type exists. ---

interface AttachedPage {
  ws: WebSocket;
  targetId: string;
  command: (method: string, params?: Record<string, unknown>) => Promise<{ result?: Record<string, unknown> }>;
}

async function attachToPage(wsUrl: string, knownTargetId?: string): Promise<AttachedPage> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Failed to open CDP WebSocket to Steel session"));
  });

  let nextId = 1;
  function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): number {
    const id = nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return id;
  }
  function waitFor(id: number): Promise<{ result?: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.removeEventListener("message", handler);
        reject(new Error(`CDP timed out waiting for a response to request ${id}`));
      }, 8000);
      const handler = (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string);
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve(msg);
        }
      };
      ws.addEventListener("message", handler);
    });
  }

  let targetId = knownTargetId;
  if (!targetId) {
    const targetsRes = await waitFor(send("Target.getTargets"));
    const targetInfos = (targetsRes.result?.["targetInfos"] as Array<{ targetId: string; type: string }>) ?? [];
    const pageTarget = targetInfos.find((t) => t.type === "page");
    if (!pageTarget) throw new Error("No page target found on the Steel session");
    targetId = pageTarget.targetId;
  }

  const attachRes = await waitFor(send("Target.attachToTarget", { targetId, flatten: true }));
  const pageSessionId = attachRes.result?.["sessionId"] as string | undefined;
  if (!pageSessionId) throw new Error("Failed to attach to the Steel session's page target");

  return {
    ws,
    targetId,
    command: (method: string, params: Record<string, unknown> = {}) => waitFor(send(method, params, pageSessionId)),
  };
}

// Reuses one attached CDP connection per session across multiple /type
// calls -- see the file header comment for the real, stated limitation
// (doesn't survive a cold start).
const pageConnections = new Map<string, AttachedPage>();

async function getOrAttachPage(sessionId: string, wsUrl: string, knownTargetId?: string): Promise<AttachedPage> {
  const cached = pageConnections.get(sessionId);
  if (cached && cached.ws.readyState === WebSocket.OPEN) return cached;
  if (cached) pageConnections.delete(sessionId);

  const page = await attachToPage(wsUrl, knownTargetId);
  page.ws.addEventListener("close", () => {
    if (pageConnections.get(sessionId) === page) pageConnections.delete(sessionId);
  });
  pageConnections.set(sessionId, page);
  return page;
}

function closeCachedPage(sessionId: string): void {
  const cached = pageConnections.get(sessionId);
  if (cached) {
    pageConnections.delete(sessionId);
    try {
      cached.ws.close();
    } catch {
      // already closed -- fine
    }
  }
}

interface SteelSession {
  id: string;
  sessionViewerUrl: string;
  websocketUrl: string;
  profileId?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/steel-login/, "") || "/";

  // --- GET /status ---
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
  if (req.method === "POST" && path === "/start") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    if (!STEEL_API_KEY) {
      return json(
        { error: "STEEL_API_KEY is not configured on the server. Add it as a secret and redeploy." },
        503,
      );
    }

    try {
      const savedProfileId = await getSavedProfileId(user!.id);
      const sessionRes = await fetch(`${STEEL_API}/sessions`, {
        method: "POST",
        headers: steelHeaders(),
        body: JSON.stringify(
          savedProfileId
            ? { profileId: savedProfileId, persistProfile: true }
            : { persistProfile: true },
        ),
      });
      if (!sessionRes.ok) {
        throw new Error(`Failed to create Steel session: ${sessionRes.status} ${await sessionRes.text()}`);
      }
      const session = (await sessionRes.json()) as SteelSession;
      if (!session.sessionViewerUrl || !session.websocketUrl) {
        throw new Error("Steel session response was missing sessionViewerUrl or websocketUrl.");
      }

      // Save the profileId immediately, not just on /complete -- harmless if
      // the user abandons the login, it just gets reused and built on next
      // time, and it means we never lose the reference even if /complete
      // never gets called.
      if (session.profileId) {
        await saveProfileId(user!.id, session.profileId);
      } else {
        console.error("Steel session response had no profileId despite persistProfile: true.");
      }

      const page = await getOrAttachPage(session.id, session.websocketUrl);
      await page.command("Page.navigate", { url: NOTEBOOKLM_URL });

      return json({ sessionId: session.id, liveViewUrl: session.sessionViewerUrl });
    } catch (err) {
      console.error("steel-login /start failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // --- POST /type  { sessionId, text, pressEnter? } ---
  if (req.method === "POST" && path === "/type") {
    const { error } = await requireUser(req);
    if (error) return error;

    const body = await req.json().catch(() => ({}));
    const { sessionId, text, pressEnter } = body as { sessionId?: string; text?: string; pressEnter?: boolean };
    if (!sessionId) return json({ error: "sessionId is required" }, 400);
    if (!text && !pressEnter) return json({ error: "Provide text and/or pressEnter" }, 400);

    try {
      const cached = pageConnections.get(sessionId);
      if (!cached) {
        throw new Error(
          "No active session found for this sessionId -- this function instance was likely " +
            "recycled between requests. Start a new login.",
        );
      }
      if (text) await cached.command("Input.insertText", { text });
      if (pressEnter) {
        const enterParams = {
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: "\r",
        };
        await cached.command("Input.dispatchKeyEvent", { type: "keyDown", ...enterParams });
        await cached.command("Input.dispatchKeyEvent", { type: "keyUp", ...enterParams });
      }
      return json({ ok: true });
    } catch (err) {
      console.error("steel-login /type failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // --- POST /complete  { sessionId } ---
  // No export step needed -- Steel's Profile (persistProfile: true, saved
  // at /start) already has whatever the user logged into by this point.
  if (req.method === "POST" && path === "/complete") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    const { sessionId } = (await req.json().catch(() => ({}))) as { sessionId?: string };
    if (!sessionId) return json({ error: "sessionId is required" }, 400);

    try {
      closeCachedPage(sessionId);

      await fetch(`${STEEL_API}/sessions/${sessionId}/release`, {
        method: "POST",
        headers: steelHeaders(),
      }).catch(() => undefined);

      await markConnected(user!.id);
      return json({ ok: true });
    } catch (err) {
      console.error("steel-login /complete failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // --- POST /disconnect ---
  if (req.method === "POST" && path === "/disconnect") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    await supabase
      .from("browserbase_contexts")
      .delete()
      .eq("user_id", user!.id)
      .eq("purpose", STEEL_PURPOSE);

    await supabase
      .from("notebooklm_connections")
      .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
      .eq("user_id", user!.id);

    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
});
