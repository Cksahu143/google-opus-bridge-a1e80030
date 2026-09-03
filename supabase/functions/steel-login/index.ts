// supabase/functions/steel-login/index.ts
//
// Steel-backed NotebookLM login flow. The browser session is persisted by
// Steel Profiles; this function stores only the opaque profile id in Supabase.

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
      vault_secret_name: `steel_profile:${STEEL_PURPOSE}`,
      connected_at: new Date().toISOString(),
      disconnected_at: null,
      status: "connected",
    },
    { onConflict: "user_id" },
  );
}

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
      // already closed
    }
  }
}

interface SteelSession {
  id: string;
  sessionViewerUrl?: string;
  debugUrl?: string;
  websocketUrl: string;
  profileId?: string;
}

function interactiveDebugUrl(debugUrl: string): string {
  const url = new URL(debugUrl);
  url.searchParams.set("interactive", "true");
  url.searchParams.set("showControls", "true");
  return url.toString();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/steel-login/, "") || "/";

  if (req.method === "GET" && path === "/status") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    const { data, error: dbError } = await supabase
      .from("notebooklm_connections")
      .select("status, connected_at, disconnected_at, last_used_at")
      .eq("user_id", user!.id)
      .maybeSingle();
    if (dbError) return json({ error: dbError.message }, 500);
    return json(data ?? { status: "disconnected", connected_at: null, disconnected_at: null, last_used_at: null });
  }

  if (req.method === "POST" && path === "/start") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    if (!STEEL_API_KEY) {
      return json({ error: "STEEL_API_KEY is not configured on the server. Add it as a secret and redeploy." }, 503);
    }

    try {
      const savedProfileId = await getSavedProfileId(user!.id);
      const sessionRes = await fetch(`${STEEL_API}/sessions`, {
        method: "POST",
        headers: steelHeaders(),
        body: JSON.stringify(savedProfileId ? { profileId: savedProfileId, persistProfile: true } : { persistProfile: true }),
      });
      if (!sessionRes.ok) {
        throw new Error(`Failed to create Steel session: ${sessionRes.status} ${await sessionRes.text()}`);
      }
      const session = (await sessionRes.json()) as SteelSession;
      if (!session.websocketUrl) {
        throw new Error("Steel session response was missing websocketUrl.");
      }

      if (session.profileId) await saveProfileId(user!.id, session.profileId);

      const page = await getOrAttachPage(session.id, session.websocketUrl);
      await page.command("Page.navigate", { url: NOTEBOOKLM_URL });

      // Steel's current embedded human-in-the-loop viewer is the debug URL,
      // not sessionViewerUrl. The latter can show Steel's own sign-in UI in
      // an iframe. debugUrl is explicitly designed for embedding; setting
      // interactive=true enables remote clicks, scrolling and form input.
      const debugUrl = session.debugUrl;
      if (!debugUrl) throw new Error("Steel session response was missing debugUrl.");

      return json({
        sessionId: session.id,
        liveViewUrl: interactiveDebugUrl(debugUrl),
      });
    } catch (err) {
      console.error("steel-login /start failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  if (req.method === "POST" && path === "/type") {
    const { error } = await requireUser(req);
    if (error) return error;

    const body = await req.json().catch(() => ({}));
    const { sessionId, text, pressEnter } = body as { sessionId?: string; text?: string; pressEnter?: boolean };
    if (!sessionId) return json({ error: "sessionId is required" }, 400);
    if (!text && !pressEnter) return json({ error: "Provide text and/or pressEnter" }, 400);

    try {
      const cached = pageConnections.get(sessionId);
      if (!cached) throw new Error("No active session found for this sessionId -- this function instance was likely recycled between requests. Start a new login.");
      if (text) await cached.command("Input.insertText", { text });
      if (pressEnter) {
        const enterParams = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" };
        await cached.command("Input.dispatchKeyEvent", { type: "keyDown", ...enterParams });
        await cached.command("Input.dispatchKeyEvent", { type: "keyUp", ...enterParams });
      }
      return json({ ok: true });
    } catch (err) {
      console.error("steel-login /type failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  if (req.method === "POST" && path === "/complete") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    const { sessionId } = (await req.json().catch(() => ({}))) as { sessionId?: string };
    if (!sessionId) return json({ error: "sessionId is required" }, 400);

    try {
      closeCachedPage(sessionId);
      await fetch(`${STEEL_API}/sessions/${sessionId}/release`, { method: "POST", headers: steelHeaders() }).catch(() => undefined);
      await markConnected(user!.id);
      return json({ ok: true });
    } catch (err) {
      console.error("steel-login /complete failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  if (req.method === "POST" && path === "/disconnect") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    await supabase.from("browserbase_contexts").delete().eq("user_id", user!.id).eq("purpose", STEEL_PURPOSE);
    await supabase.from("notebooklm_connections").update({ status: "disconnected", disconnected_at: new Date().toISOString() }).eq("user_id", user!.id);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
});
