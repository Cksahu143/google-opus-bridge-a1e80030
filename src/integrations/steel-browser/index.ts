import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { NexusError } from "@/lib/nexus/errors";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * General-purpose live browser sessions on Steel -- NOT tied to
 * NotebookLM or any saved login. Every capability here returns (or
 * reuses) a `liveViewUrl` for watching this app drive a browser in real
 * time.
 *
 * CONFIRMED BY LIVE TEST: Steel's sessionViewerUrl sends its own
 * X-Frame-Options/CSP frame-ancestors headers that refuse to render
 * inside a third-party iframe -- it loads blank there. It only works
 * opened directly as a top-level tab.
 *
 * ARCHITECTURE -- CONFIRMED BY LIVE TEST (previously broken):
 * This function runs as a stateless serverless invocation: every single
 * tool call is a brand-new instance with empty memory. An in-memory
 * `Map` of CDP connections (the previous implementation) CANNOT survive
 * between calls -- not "sometimes", never, by construction. Verified
 * live: start_session succeeded, and the very next click on the same
 * sessionId failed instantly with session-not-found.
 *
 * Fix: session identity (the Steel session's websocketUrl) is persisted
 * in Supabase (steel_live_sessions), and every capability call opens a
 * FRESH CDP WebSocket connection using that stored URL, does its one
 * command, then closes the socket. This is slightly slower per call
 * (a new CDP handshake each time) but is the only architecture that
 * actually works in a serverless environment -- the alternative would
 * be a stateful edge runtime (e.g. a Durable Object), which this app
 * does not use elsewhere.
 *
 * Requires STEEL_API_KEY as an environment variable on this app.
 */

const STEEL_API = "https://api.steel.dev/v1";
const CDP_TIMEOUT_MS = 8_000;
const PAGE_LOAD_TIMEOUT_MS = 15_000;

function requireSteelConfig(): { apiKey: string } {
  const apiKey = process.env["STEEL_API_KEY"]?.trim();
  if (!apiKey) {
    throw new NexusError(
      "steel_browser_not_configured",
      "STEEL_API_KEY must be set as an environment variable on this app.",
      503,
    );
  }
  return { apiKey };
}

function steelHeaders(apiKey: string): Record<string, string> {
  return { "steel-api-key": apiKey, "content-type": "application/json" };
}

function supabaseAdmin() {
  const url = process.env["SUPABASE_URL"];
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !serviceKey) {
    throw new NexusError(
      "steel_browser_storage_not_configured",
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to persist live-browser session state.",
      503,
    );
  }
  return createClient(url, serviceKey);
}

interface StoredSession {
  steel_session_id: string;
  websocket_url: string;
  current_url: string | null;
}

async function saveSession(userId: string, steelSessionId: string, websocketUrl: string, currentUrl: string) {
  const { error } = await supabaseAdmin().from("steel_live_sessions").insert({
    user_id: userId,
    steel_session_id: steelSessionId,
    websocket_url: websocketUrl,
    current_url: currentUrl,
  });
  if (error) {
    throw new NexusError("steel_browser_storage_failed", `Failed to persist session: ${error.message}`, 500);
  }
}

async function loadSession(userId: string, steelSessionId: string): Promise<StoredSession> {
  const { data, error } = await supabaseAdmin()
    .from("steel_live_sessions")
    .select("steel_session_id, websocket_url, current_url")
    .eq("user_id", userId)
    .eq("steel_session_id", steelSessionId)
    .maybeSingle();
  if (error) {
    throw new NexusError("steel_browser_storage_failed", `Failed to load session: ${error.message}`, 500);
  }
  if (!data) {
    throw new NexusError(
      "steel_browser_session_not_found",
      "No stored session for this sessionId -- either it was never started here, or it already ended. Call start_session again.",
      404,
    );
  }
  return data;
}

async function touchSession(userId: string, steelSessionId: string, currentUrl?: string) {
  const update: Record<string, unknown> = { last_used_at: new Date().toISOString() };
  if (currentUrl) update["current_url"] = currentUrl;
  await supabaseAdmin()
    .from("steel_live_sessions")
    .update(update)
    .eq("user_id", userId)
    .eq("steel_session_id", steelSessionId);
}

async function deleteSession(userId: string, steelSessionId: string) {
  await supabaseAdmin()
    .from("steel_live_sessions")
    .delete()
    .eq("user_id", userId)
    .eq("steel_session_id", steelSessionId);
}

interface CdpPage {
  ws: WebSocket;
  command: (method: string, params?: Record<string, unknown>) => Promise<{ result?: Record<string, unknown> }>;
  waitForEvent: (method: string, timeoutMs: number) => Promise<void>;
  close: () => void;
}

/** Opens a brand-new CDP connection for a single call. Caller must call page.close() when done. */
async function attachToPage(wsUrl: string): Promise<CdpPage> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new NexusError("steel_browser_connect_failed", "Failed to open CDP WebSocket to the Steel session -- it may have expired.", 502));
  });

  let nextId = 1;
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  const eventWaiters = new Map<string, Array<() => void>>();

  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (typeof msg["id"] === "number" && pending.has(msg["id"] as number)) {
      pending.get(msg["id"] as number)!(msg);
      pending.delete(msg["id"] as number);
    } else if (typeof msg["method"] === "string") {
      const waiters = eventWaiters.get(msg["method"] as string);
      if (waiters?.length) waiters.splice(0).forEach((resolve) => resolve());
    }
  };

  function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): number {
    const id = nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload["sessionId"] = sessionId;
    ws.send(JSON.stringify(payload));
    return id;
  }

  function waitFor(id: number): Promise<{ result?: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timed out waiting for a response to request ${id}`));
      }, CDP_TIMEOUT_MS);
      pending.set(id, (msg) => {
        clearTimeout(timeout);
        resolve(msg as { result?: Record<string, unknown> });
      });
    });
  }

  const targetsRes = await waitFor(send("Target.getTargets"));
  const targetInfos =
    (targetsRes.result?.["targetInfos"] as Array<{ targetId: string; type: string }>) ?? [];
  const pageTarget = targetInfos.find((t) => t.type === "page");
  if (!pageTarget) {
    ws.close();
    throw new NexusError("steel_browser_no_page", "No page target found on the Steel session.", 502);
  }

  const attachRes = await waitFor(
    send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true }),
  );
  const pageSessionId = attachRes.result?.["sessionId"] as string | undefined;
  if (!pageSessionId) {
    ws.close();
    throw new NexusError("steel_browser_attach_failed", "Failed to attach to the Steel session's page target.", 502);
  }

  const page: CdpPage = {
    ws,
    command: (method, params = {}) => waitFor(send(method, params, pageSessionId)),
    waitForEvent: (method, timeoutMs) =>
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs);
        const list = eventWaiters.get(method) ?? [];
        list.push(() => {
          clearTimeout(timeout);
          resolve();
        });
        eventWaiters.set(method, list);
      }),
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed -- fine
      }
    },
  };

  await page.command("Page.enable");
  await page.command("Runtime.enable");
  await page.command("DOM.enable");
  return page;
}

async function evaluateJson<T>(page: CdpPage, expression: string): Promise<T> {
  const res = await page.command("Runtime.evaluate", { expression, returnByValue: true });
  const result = res.result?.["result"] as { value?: unknown; subtype?: string } | undefined;
  if (result?.subtype === "error") {
    throw new NexusError("steel_browser_eval_failed", "The page script threw an error.", 502);
  }
  return (result?.value ?? null) as T;
}

/** Runs `fn` against a fresh CDP connection to the stored session, always closing the socket after. */
async function withPage<T>(userId: string, steelSessionId: string, fn: (page: CdpPage) => Promise<T>): Promise<T> {
  const stored = await loadSession(userId, steelSessionId);
  const page = await attachToPage(stored.websocket_url);
  try {
    return await fn(page);
  } finally {
    page.close();
  }
}

export const steelBrowserAdapter = defineAdapter({
  service: "steel-browser",
  label: "Live Browser (Steel)",
  description:
    "General-purpose real browser sessions with a live view you can watch -- navigate, click, " +
    "type, and read pages in real time, not bound to any saved login.",
  status: "partial",
  statusNote:
    "Session identity is persisted in Supabase and each call opens a fresh CDP connection -- " +
    "this replaced a broken in-memory implementation that could never survive between calls in " +
    "this serverless environment (confirmed by live test). Also requires SUPABASE_URL and " +
    "SUPABASE_SERVICE_ROLE_KEY. The returned liveViewUrl only works opened as a top-level tab -- " +
    "Steel's own frame-ancestors policy blocks it from rendering inside any embedded iframe, " +
    "confirmed by live test. Requires STEEL_API_KEY as an env var on this app.",
  requiresGoogleAuth: false,
  docsUrl: "https://docs.steel.dev",
  capabilities: [
    defineCapability({
      id: "steel_browser.start_session",
      title: "Start a live browser session",
      description:
        "Opens a real browser session and navigates to a URL. Returns a liveViewUrl -- open it " +
        "directly in its own browser tab to watch every action happen in real time. It cannot be " +
        "embedded in an iframe: Steel's own frame-ancestors policy blocks that and it will render " +
        "blank, confirmed by live test.",
      implementation: "browser-automation",
      scopes: [],
      mutating: true,
      input: z.object({
        url: z.string().url(),
        profileId: z
          .string()
          .optional()
          .describe("Reuse a previously saved Steel profile instead of starting logged-out."),
      }),
      run: async (ctx, input) => {
        const { apiKey } = requireSteelConfig();
        const sessionRes = await fetch(`${STEEL_API}/sessions`, {
          method: "POST",
          headers: steelHeaders(apiKey),
          body: JSON.stringify(
            input.profileId ? { profileId: input.profileId, persistProfile: true } : {},
          ),
        });
        if (!sessionRes.ok) {
          throw new NexusError(
            "steel_browser_session_failed",
            `Failed to create a Steel session: ${sessionRes.status} ${await sessionRes.text()}`,
            502,
          );
        }
        const session = (await sessionRes.json()) as {
          id: string;
          sessionViewerUrl?: string;
          websocketUrl?: string;
        };
        if (!session.sessionViewerUrl || !session.websocketUrl) {
          throw new NexusError("steel_browser_session_failed", "Steel session response was incomplete.", 502);
        }

        const page = await attachToPage(session.websocketUrl);
        try {
          await page.command("Page.navigate", { url: input.url });
          await page.waitForEvent("Page.loadEventFired", PAGE_LOAD_TIMEOUT_MS);
        } finally {
          page.close();
        }

        await saveSession(ctx.userId, session.id, session.websocketUrl, input.url);

        return {
          sessionId: session.id,
          liveViewUrl: session.sessionViewerUrl,
          liveViewNote: "Open this URL in its own browser tab. It will not render inside an embedded iframe.",
        };
      },
    }),
    defineCapability({
      id: "steel_browser.navigate",
      title: "Navigate to a URL",
      description: "Navigates an existing live session to a new URL.",
      implementation: "browser-automation",
      scopes: [],
      mutating: true,
      input: z.object({ sessionId: z.string(), url: z.string().url() }),
      run: async (ctx, input) => {
        await withPage(ctx.userId, input.sessionId, async (page) => {
          await page.command("Page.navigate", { url: input.url });
          await page.waitForEvent("Page.loadEventFired", PAGE_LOAD_TIMEOUT_MS);
        });
        await touchSession(ctx.userId, input.sessionId, input.url);
        return { ok: true };
      },
    }),
    defineCapability({
      id: "steel_browser.click",
      title: "Click an element",
      description:
        "Clicks the first element matching a CSS selector, using a real synthesized mouse event " +
        "at the element's on-screen position (not a scripted .click() call) so it behaves like a " +
        "genuine user click.",
      implementation: "browser-automation",
      scopes: [],
      mutating: true,
      input: z.object({ sessionId: z.string(), selector: z.string().min(1) }),
      run: async (ctx, input) => {
        await withPage(ctx.userId, input.sessionId, async (page) => {
          const rect = await evaluateJson<{ x: number; y: number } | null>(
            page,
            `(() => {
              const el = document.querySelector(${JSON.stringify(input.selector)});
              if (!el) return null;
              el.scrollIntoView({ block: "center", inline: "center" });
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            })()`,
          );
          if (!rect) {
            throw new NexusError("steel_browser_element_not_found", `No element matched "${input.selector}".`, 404);
          }
          await page.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
          await page.command("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: rect.x,
            y: rect.y,
            button: "left",
            clickCount: 1,
          });
          await page.command("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: rect.x,
            y: rect.y,
            button: "left",
            clickCount: 1,
          });
        });
        await touchSession(ctx.userId, input.sessionId);
        return { ok: true };
      },
    }),
    defineCapability({
      id: "steel_browser.type",
      title: "Type text",
      description:
        "Types text into whatever element currently has focus (click a field first). Optionally " +
        "presses Enter afterward.",
      implementation: "browser-automation",
      scopes: [],
      mutating: true,
      input: z.object({ sessionId: z.string(), text: z.string(), pressEnter: z.boolean().default(false) }),
      run: async (ctx, input) => {
        await withPage(ctx.userId, input.sessionId, async (page) => {
          if (input.text) await page.command("Input.insertText", { text: input.text });
          if (input.pressEnter) {
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
        });
        await touchSession(ctx.userId, input.sessionId);
        return { ok: true };
      },
    }),
    defineCapability({
      id: "steel_browser.read",
      title: "Read the page",
      description:
        "Reads the visible text of the whole page, or of one element if a selector is given.",
      implementation: "browser-automation",
      scopes: [],
      input: z.object({ sessionId: z.string(), selector: z.string().optional() }),
      run: async (ctx, input) => {
        const result = await withPage(ctx.userId, input.sessionId, async (page) => {
          const text = await evaluateJson<string | null>(
            page,
            input.selector
              ? `document.querySelector(${JSON.stringify(input.selector)})?.innerText ?? null`
              : `document.body.innerText`,
          );
          const urlValue = await evaluateJson<string>(page, "window.location.href");
          return { url: urlValue, text };
        });
        await touchSession(ctx.userId, input.sessionId, result.url);
        return result;
      },
    }),
    defineCapability({
      id: "steel_browser.end_session",
      title: "End a live browser session",
      description: "Closes the session and releases it on Steel.",
      implementation: "browser-automation",
      scopes: [],
      mutating: true,
      input: z.object({ sessionId: z.string() }),
      run: async (ctx, input) => {
        const { apiKey } = requireSteelConfig();
        await deleteSession(ctx.userId, input.sessionId);
        await fetch(`${STEEL_API}/sessions/${input.sessionId}/release`, {
          method: "POST",
          headers: steelHeaders(apiKey),
        }).catch(() => undefined);
        return { ok: true };
      },
    }),
  ],
});

export default steelBrowserAdapter;
