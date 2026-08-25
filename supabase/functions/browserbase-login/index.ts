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
//      user, starts a Session bound to that Context, navigates it to
//      NotebookLM (see navigateSession below), and returns the session's
//      Live View URL -- a real, interactive iframe-able browser the user
//      logs into Google/NotebookLM inside of.
//   2. Browserbase's Context persists cookies/localStorage server-side,
//      encrypted at rest, keyed by an opaque context id. We only ever
//      store that id (in browserbase_contexts), never any cookie or
//      credential material ourselves.
//   3. /type exists because iOS/iPadOS Safari will not raise its virtual
//      keyboard for an element inside a remote/screencast iframe -- there
//      is no local DOM input for it to attach to, since the actual login
//      form lives inside Browserbase's remote Chrome instance, not on the
//      device. connect.tsx gives the user a real local text box instead
//      (which iPadOS *will* raise a keyboard for) and this endpoint
//      forwards whatever they type into the remote page's focused field
//      via CDP Input.insertText, which is designed for exactly this kind
//      of non-keystroke text insertion (it's the same mechanism used for
//      emoji-keyboard/IME input).
//   4. /complete just confirms the session actually ran and flips the
//      user to "connected" in notebooklm_connections.
//   5. Future automated NotebookLM actions would start a *new* session
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
// Where the session should land so the user has something to log into,
// instead of the browser's default blank tab.
const LOGIN_START_URL = "https://notebooklm.google.com/";

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

// Closes an active session immediately instead of waiting out its 15-minute
// free-tier timeout. Confirmed against Browserbase's own docs: POST
// /v1/sessions/{id} with status: "REQUEST_RELEASE". Without this, every
// single login attempt permanently consumes one of the free tier's 3
// concurrent-session slots until it naturally expires.
async function closeSession(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`${BROWSERBASE_API}/sessions/${sessionId}`, {
      method: "POST",
      headers: bbHeaders(),
      body: JSON.stringify({ projectId: BROWSERBASE_PROJECT_ID, status: "REQUEST_RELEASE" }),
    });
    if (!res.ok) {
      console.error(`Failed to close session ${sessionId}: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(`Error closing session ${sessionId}:`, err);
  }
}

// Re-fetches a session's connectUrl. Needed because each edge function
// invocation is a fresh, short-lived isolate -- the CDP connection opened
// during /start does not survive into a later /type request, so /type has
// to reconnect. GET /v1/sessions/{id} includes the same connectUrl the
// create-session response does.
async function getSessionConnectUrl(sessionId: string): Promise<string> {
  const res = await fetch(`${BROWSERBASE_API}/sessions/${sessionId}`, { headers: bbHeaders() });
  if (!res.ok) {
    throw new Error(`Failed to look up session ${sessionId}: ${res.status} ${await res.text()}`);
  }
  const { connectUrl } = (await res.json()) as { connectUrl?: string };
  if (!connectUrl) throw new Error(`Session ${sessionId} has no connectUrl (already closed?)`);
  return connectUrl;
}

// Minimal hand-rolled CDP client (no Playwright dependency available in a
// Deno edge function). Opens connectUrl, attaches to the session's one
// page target, and returns helpers scoped to that page's CDP session so
// callers can send multiple commands (e.g. insertText then a keypress)
// over one connection.
async function attachToPage(connectUrl: string, knownTargetId?: string) {
  const ws = new WebSocket(connectUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Failed to open CDP WebSocket to Browserbase session"));
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

  // Skips a full round-trip to re-discover the page target on every call
  // when the caller already knows it (from /start's response) — the page
  // doesn't change mid-session, so re-listing targets on every keystroke
  // send was pure wasted latency, not a correctness requirement.
  let targetId = knownTargetId;
  if (!targetId) {
    const targetsRes = await waitFor(send("Target.getTargets"));
    const targetInfos =
      (targetsRes.result?.["targetInfos"] as Array<{ targetId: string; type: string }>) ?? [];
    const pageTarget = targetInfos.find((t) => t.type === "page");
    if (!pageTarget) throw new Error("No page target found on the Browserbase session");
    targetId = pageTarget.targetId;
  }

  const attachRes = await waitFor(send("Target.attachToTarget", { targetId, flatten: true }));
  const pageSessionId = attachRes.result?.["sessionId"] as string | undefined;
  if (!pageSessionId) throw new Error("Failed to attach to the Browserbase session's page target");

  return {
    ws,
    targetId,
    command: (method: string, params: Record<string, unknown> = {}) =>
      waitFor(send(method, params, pageSessionId)),
  };
}

type AttachedPage = Awaited<ReturnType<typeof attachToPage>>;

// Reuses one attached CDP connection per Browserbase session across
// multiple /type calls, instead of attaching and detaching on every single
// call. This exists because BOTH navigateSession (a single attach, never
// closed) and the original typeIntoSession (attach+detach per call) were
// independently observed to cause the Live View iframe to disconnect —
// which points to the disruption coming from the *act* of a new
// Target.attachToTarget on the target Live View is already watching, not
// specifically from overlapping/concurrent connections. Minimizing how
// many times that happens per session is the fix: attach once, reuse for
// every keystroke-group, and only detach when the login flow actually
// ends (/complete, /disconnect, or this isolate being recycled).
//
// Deno Edge Function isolates stay warm across closely-spaced requests
// (this is standard, documented Deno Deploy/Supabase Edge Functions
// behavior, not a special trick), so module-level state here is reused
// for the rapid-fire sequence of /type calls a real login produces —
// email, then password, then Enter, typically seconds apart. A cold
// start (isolate recycled between calls) just means a fresh attach,
// which is the same behavior as before this change, not a regression.
const pageConnections = new Map<string, AttachedPage>();

async function getOrAttachPage(
  sessionId: string,
  connectUrl: string,
  knownTargetId?: string,
): Promise<AttachedPage> {
  const cached = pageConnections.get(sessionId);
  if (cached && cached.ws.readyState === WebSocket.OPEN) return cached;
  if (cached) pageConnections.delete(sessionId); // stale/closed — drop it, attach fresh below

  const page = await attachToPage(connectUrl, knownTargetId);
  page.ws.addEventListener("close", () => {
    // Don't let a closed connection linger in the cache as a false hit.
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
      // already closed — fine, that was the goal anyway.
    }
  }
}

// THE FIX for the "live view shows about:blank" bug: a freshly created
// Browserbase session's default tab is a blank page — nothing navigates it
// anywhere on its own. Browserbase's own examples always call page.goto()
// via Playwright/Puppeteer immediately after creating a session, before
// reading the debug URL, for exactly this reason.
//
// IMPORTANT: deliberately does not ws.close() when done. Closing it
// immediately (during /start, while the Live View is still initializing)
// caused the Live View iframe to show "WebSocket disconnected" -- every
// official Browserbase example keeps this connection open for the life of
// the session rather than attaching-and-detaching, so a deliberate detach
// right after navigating appears to tear down state the Live View's own
// connection depends on during that initial handshake window. Left to
// close naturally when this function's Deno isolate is later recycled.
// (Compare typeIntoSession below, which DOES close -- see its comment for
// why that's a different situation.)
async function navigateSession(connectUrl: string, targetUrl: string): Promise<string> {
  const page = await attachToPage(connectUrl);
  await page.command("Page.navigate", { url: targetUrl });
  return page.targetId;
}

// Types text into whatever element is currently focused in the remote
// page, using CDP's Input.insertText -- the same mechanism Chrome uses
// for IME/emoji-keyboard input, i.e. text that doesn't come from raw
// keystrokes. This exists specifically to work around iOS/iPadOS Safari
// not raising a virtual keyboard for elements inside a remote/screencast
// iframe (see the file header comment). The user still has to tap the
// field once in the Live View to focus it -- taps/clicks are forwarded
// fine by Browserbase's own Live View, it's only the OS keyboard that
// doesn't appear.
//
// UNLIKE navigateSession, this DOES close its connection when done (after
// a short buffer for the commands to be processed). A multi-step login
// calls this endpoint repeatedly -- email, then password, then Enter --
// and each call was opening a brand new CDP connection to the same
// session and never closing any of them. By the time the user was a few
// fields into the login, several simultaneous connections had piled up
// against one session, which is what was producing "WebSocket
// disconnected" mid-login: almost certainly a concurrent-connection limit
// on the session getting exceeded, evicting whichever connection the Live
// View itself depends on. /start's navigateSession only ever runs once
// per session, so it doesn't have this accumulation problem.
async function typeIntoSession(
  connectUrl: string,
  text: string,
  pressEnter: boolean,
  knownTargetId?: string,
): Promise<void> {
  const page = await attachToPage(connectUrl, knownTargetId);
  try {
    if (text) {
      await page.command("Input.insertText", { text });
    }
    if (pressEnter) {
      const enterParams = {
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: "\r",
      };
      await page.command("Input.dispatchKeyEvent", { type: "keyDown", ...enterParams });
      await page.command("Input.dispatchKeyEvent", { type: "keyUp", ...enterParams });
    }
    // Small buffer before detaching so the commands are fully processed
    // server-side first, rather than closing the instant the ack arrives.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    page.ws.close();
  }
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
      data ?? {
        status: "disconnected",
        connected_at: null,
        disconnected_at: null,
        last_used_at: null,
      },
    );
  }

  // --- POST /start ---
  // Creates a session bound to the user's persistent context, navigates it
  // to NotebookLM, and returns its Live View URL for the frontend to embed
  // in an <iframe>.
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
        throw new Error(
          `Failed to create Browserbase session: ${sessionRes.status} ${await sessionRes.text()}`,
        );
      }
      const session = (await sessionRes.json()) as { id: string; connectUrl?: string };

      // THE FIX: navigate the session before reading its live view URL, or
      // the iframe just shows the browser's default blank tab (this was the
      // literal "about:blank" bug). Non-fatal if it fails -- the live view
      // still works, the user just has to type the URL in manually, which
      // beats blocking the whole connect flow on a CDP hiccup.
      if (session.connectUrl) {
        try {
          await navigateSession(session.connectUrl, LOGIN_START_URL);
        } catch (navErr) {
          console.error("Failed to navigate Browserbase session (non-fatal):", navErr);
        }
      } else {
        console.error("Browserbase session response had no connectUrl — cannot auto-navigate.");
      }

      const debugRes = await fetch(`${BROWSERBASE_API}/sessions/${session.id}/debug`, {
        headers: bbHeaders(),
      });
      if (!debugRes.ok) {
        throw new Error(
          `Failed to fetch live view URL: ${debugRes.status} ${await debugRes.text()}`,
        );
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
        console.error(
          "Browserbase /debug returned no usable URL. Raw response:",
          JSON.stringify(debug),
        );
        throw new Error("Browserbase returned no live view URL for this session.");
      }

      return json({ sessionId: session.id, liveViewUrl });
    } catch (err) {
      console.error("browserbase-login /start failed:", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // --- POST /type  { sessionId, text, pressEnter? } ---
  // Forwards locally-typed text into the remote session's currently
  // focused field (see typeIntoSession's comment for why this exists).
  // Not fatal to the connect flow if this specific call fails -- the user
  // can still use an external keyboard or a desktop browser as a fallback,
  // so a clear error here beats losing the whole session.
  if (req.method === "POST" && path === "/type") {
    const { user, error } = await requireUser(req);
    if (error) return error;

    const body = await req.json().catch(() => ({}));
    const { sessionId, text, pressEnter } = body as {
      sessionId?: string;
      text?: string;
      pressEnter?: boolean;
    };
    if (!sessionId) {
      return json({ error: "sessionId is required" }, 400);
    }
    if (!text && !pressEnter) {
      return json({ error: "Provide text and/or pressEnter" }, 400);
    }

    try {
      const connectUrl = await getSessionConnectUrl(sessionId);
      await typeIntoSession(connectUrl, text ?? "", Boolean(pressEnter));
      return json({ ok: true });
    } catch (err) {
      console.error("browserbase-login /type failed:", err);
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

      // The login is already captured in the persistent Context by this
      // point (persist: true on /start) — the live session itself is no
      // longer needed. Close it now rather than leaving it running for up
      // to 15 more minutes, consuming one of only 3 free-tier concurrent
      // session slots for no reason.
      await closeSession(sessionId);

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
          console.error(
            "Failed to delete Browserbase context:",
            delRes.status,
            await delRes.text(),
          );
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
