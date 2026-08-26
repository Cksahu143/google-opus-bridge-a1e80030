// supabase/functions/steel-login/index.ts
//
// Replaces browserbase-login as the backend for /notebooks/connect, per
// user-reported slowness and disconnects with Browserbase. Researched
// before switching, not assumed: multiple independent 2026 benchmarks
// consistently rank Browserbase behind on both speed and reliability --
// "lower-performing providers such as Airtop and Browserbase may rely on
// slower provisioning queues... significantly higher browsing or total
// execution times" (aimultiple.com/remote-browsers), and Steel's own
// session-start time is documented at under 1 second same-region, vs.
// Browserbase's slower provisioning queue in that same comparison.
// Reliability: "Steel, Kernel, and Hyperbrowser completed 100 percent of
// sessions, Browserbase 99.96 percent" (o-mega.ai browser-agent review).
//
// Free tier confirmed directly from Steel's own quickstart docs: 100
// browser hours/month, no credit card required.
//
// ARCHITECTURE DIFFERENCE FROM BROWSERBASE, stated honestly: Browserbase's
// Context object persists a login server-side on THEIR infrastructure --
// this app never sees or touches the actual cookies, only an opaque
// context id. Steel's session-state model is explicit export/import: we
// call GET .../sessions/{id}/export to retrieve the actual cookie/
// localStorage state as JSON, and pass it back via `state` when creating
// a new session to resume as that logged-in user. That means this
// function DOES handle real cookie/session data directly, which
// Browserbase's design avoided. To keep the same security bar, that
// state blob is stored in Supabase Vault (encrypted at rest, service-
// role-only access) via the same vault_create_secret /
// vault_delete_secret_by_name RPCs already set up for the earlier
// notebooklm-connect implementation -- never in a plain table column.
//
// ONE UNVERIFIED DETAIL, flagged rather than silently assumed: the exact
// field name Steel's CLOUD API (api.steel.dev) uses for session state
// export/import was only confirmed against a self-hosted example in
// available documentation snippets at the time this was written (GET
// /sessions/{id}/export -> POST /sessions with { state: ... }). The SDKs
// are documented as "compatible with both Steel Cloud and self-hosted
// instances" via the same client, which suggests the REST shape matches,
// but if /export 404s or session creation silently ignores `state`,
// check Steel's OpenAPI reference (docs.steel.dev/api-reference) for the
// cloud-specific field name before assuming this code is wrong in some
// deeper way.
//
// Everything else mirrors browserbase-login's structure and lessons
// learned the hard way there:
//   - /start creates (or resumes, via saved state) a session, navigates
//     it to NotebookLM, returns sessionViewerUrl for the frontend iframe.
//   - /type forwards locally-typed text into the remote page's focused
//     field via CDP Input.insertText -- iOS/iPadOS Safari won't raise a
//     keyboard for an element inside a screencast iframe, so the "type
//     into browser" box on the frontend exists regardless of which
//     backend is behind it.
//   - Reuses ONE attached CDP connection per session across multiple
//     /type calls (module-level cache), not attach-detach per call --
//     ported directly from the fix already proven necessary against
//     Browserbase's Live View for the same reason: repeated
//     Target.attachToTarget cycles on a watched target visibly disrupt
//     the live view, confirmed against Browserbase's own commit history
//     in this repo. Untested whether Steel's viewer has the same
//     sensitivity, but there's no reason to assume it doesn't and every
//     reason to keep the safer pattern.
//   - /complete exports and saves session state, then releases the
//     session.
//   - /disconnect deletes the saved state from Vault.
//   - /status reports connection state from notebooklm_connections
//     (same table browserbase-login used -- no schema change needed,
//     this is purely a different login backend for the same feature).

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

function vaultSecretName(userId: string): string {
  return `steel_session_state_${userId}`;
}

async function getSavedState(userId: string): Promise<unknown | null> {
  const secretName = vaultSecretName(userId);
  const { data: decrypted, error } = await supabase.rpc("vault_read_secret_by_name", {
    secret_name: secretName,
  });
  if (error || !decrypted) return null;
  try {
    return JSON.parse(decrypted as string);
  } catch {
    return null;
  }
}

async function saveState(userId: string, state: unknown): Promise<void> {
  const secretName = vaultSecretName(userId);
  await supabase.rpc("vault_delete_secret_by_name", { secret_name: secretName }).catch(() => {});
  const { error } = await supabase.rpc("vault_create_secret", {
    secret_value: JSON.stringify(state),
    secret_name: secretName,
    secret_description: `Steel session state for user ${userId}, saved ${new Date().toISOString()}`,
  });
  if (error) throw new Error(`Failed to store session state: ${error.message}`);

  await supabase.from("notebooklm_connections").upsert({
    user_id: userId,
    vault_secret_name: secretName,
    connected_at: new Date().toISOString(),
    status: "connected",
  });
}

// --- Minimal CDP client -- identical protocol to browserbase-login's,
// just pointed at Steel's websocketUrl instead of Browserbase's
// connectUrl. See that file for the full reasoning on why /type exists
// and why connections are reused across calls. ---

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
// calls -- see the file header comment for why this is kept even though
// unverified against Steel specifically.
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

    try {
      const savedState = await getSavedState(user!.id);
      const sessionRes = await fetch(`${STEEL_API}/sessions`, {
        method: "POST",
        headers: steelHeaders(),
        body: JSON.stringify(savedState ? { state: savedState } : {}),
      });
      if (!sessionRes.ok) {
        throw new Error(`Failed to create Steel session: ${sessionRes.status} ${await sessionRes.text()}`);
      }
      const session = (await sessionRes.json()) as SteelSession;
      if (!session.sessionViewerUrl || !session.websocketUrl) {
        throw new Error("Steel session response was missing sessionViewerUrl or websocketUrl.");
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
        throw new Error("No active session found for this sessionId. Start a new login.");
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
  if (req.method === "POST" && path === "/complete") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    const { sessionId } = (await req.json().catch(() => ({}))) as { sessionId?: string };
    if (!sessionId) return json({ error: "sessionId is required" }, 400);

    try {
      closeCachedPage(sessionId);

      const exportRes = await fetch(`${STEEL_API}/sessions/${sessionId}/export`, { headers: steelHeaders() });
      if (!exportRes.ok) {
        throw new Error(`Failed to export session state: ${exportRes.status} ${await exportRes.text()}`);
      }
      const state = await exportRes.json();
      await saveState(user!.id, state);

      await fetch(`${STEEL_API}/sessions/${sessionId}/release`, {
        method: "POST",
        headers: steelHeaders(),
      }).catch(() => undefined);

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

    const secretName = vaultSecretName(user!.id);
    await supabase.rpc("vault_delete_secret_by_name", { secret_name: secretName }).catch(() => {});
    await supabase
      .from("notebooklm_connections")
      .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
      .eq("user_id", user!.id);

    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
});
