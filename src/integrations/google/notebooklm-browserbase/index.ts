import { z } from "zod";

import { NexusError } from "@/lib/nexus/errors";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * NotebookLM integration backed by the SAME Browserbase-captured login the
 * user creates on /notebooks/connect (browserbase_contexts /
 * notebooklm_connections in Supabase, wired up by the browserbase-login
 * Edge Function). This is deliberately NOT the notebooklm-native adapter,
 * which talks to an external, unrelated, and unconfigured community MCP
 * server (PleasePrompto/notebooklm-mcp) that has never touched this login.
 *
 * Scope, honestly: only get_health and list_notebooks are implemented.
 * NotebookLM's real page structure (for asking questions, adding sources,
 * generating audio) is not something this adapter's author can inspect or
 * test live -- guessing at DOM selectors for those would risk either
 * silent failures or, worse for `ask`, plausible-looking but fabricated
 * answers. list_notebooks only reads notebook links by URL pattern
 * (/notebook/<id>), which is a stable, documented NotebookLM URL
 * convention rather than a guessed CSS selector, so it's a much safer bet.
 *
 * Requires BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID as environment
 * variables on THIS app (Lovable project env vars) -- a separate secret
 * store from the Supabase Edge Function secrets already configured for
 * browserbase-login. Same free Browserbase account, just needs the same
 * two values set again here.
 */

const BROWSERBASE_API = "https://api.browserbase.com/v1";
const NOTEBOOKLM_PURPOSE = "notebooklm";
const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const CDP_TIMEOUT_MS = 8_000;
const PAGE_LOAD_TIMEOUT_MS = 15_000;
const POST_LOAD_SETTLE_MS = 1_500;

function requireBrowserbaseConfig(): { apiKey: string; projectId: string } {
  const apiKey = process.env["BROWSERBASE_API_KEY"]?.trim();
  const projectId = process.env["BROWSERBASE_PROJECT_ID"]?.trim();
  if (!apiKey || !projectId) {
    throw new NexusError(
      "notebooklm_browserbase_not_configured",
      "BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be set as environment variables " +
        "on this app (separate from the same-named Supabase Edge Function secrets already " +
        "configured for browserbase-login -- Lovable env vars are a different store).",
      503,
    );
  }
  return { apiKey, projectId };
}

function bbHeaders(apiKey: string): Record<string, string> {
  return { "X-BB-API-Key": apiKey, "Content-Type": "application/json" };
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** The context id captured when the user logged in via /notebooks/connect. */
async function getStoredContextId(userId: string): Promise<string> {
  const db = await admin();
  const { data, error } = await db
    .from("browserbase_contexts")
    .select("context_id")
    .eq("user_id", userId)
    .eq("purpose", NOTEBOOKLM_PURPOSE)
    .maybeSingle();
  if (error) throw error;
  if (!data?.context_id) {
    throw new NexusError(
      "notebooklm_not_connected",
      "No NotebookLM login found for this user. Visit /notebooks/connect and log in first.",
      412,
    );
  }
  return data.context_id as string;
}

// --- Minimal CDP client (same technique as the browserbase-login Edge
// Function's /type endpoint, reimplemented here since this runs in a
// separate Node process with its own module scope, not Deno). ---

interface CdpPage {
  ws: WebSocket;
  command: (method: string, params?: Record<string, unknown>) => Promise<{ result?: Record<string, unknown> }>;
  waitForEvent: (method: string, timeoutMs: number) => Promise<void>;
}

async function attachToPage(connectUrl: string): Promise<CdpPage> {
  const ws = new WebSocket(connectUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Failed to open CDP WebSocket to Browserbase session"));
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
      if (waiters?.length) {
        waiters.splice(0).forEach((resolve) => resolve());
      }
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
  if (!pageTarget) throw new Error("No page target found on the Browserbase session");

  const attachRes = await waitFor(
    send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true }),
  );
  const pageSessionId = attachRes.result?.["sessionId"] as string | undefined;
  if (!pageSessionId) throw new Error("Failed to attach to the Browserbase session's page target");

  const page: CdpPage = {
    ws,
    command: (method, params = {}) => waitFor(send(method, params, pageSessionId)),
    waitForEvent: (method, timeoutMs) =>
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs); // timeout resolves too -- best-effort wait, not a hard requirement
        const list = eventWaiters.get(method) ?? [];
        list.push(() => {
          clearTimeout(timeout);
          resolve();
        });
        eventWaiters.set(method, list);
      }),
  };

  await page.command("Page.enable");
  await page.command("Runtime.enable");
  return page;
}

/**
 * Opens a short-lived Browserbase session bound to the user's saved
 * NotebookLM context, navigates to a URL, waits for it to settle, runs
 * `evaluate` against the live page, then always closes the session
 * (REQUEST_RELEASE) so it doesn't sit consuming one of the free tier's 3
 * concurrent-session slots. Read-only by design -- this never types
 * anything or clicks anything, only reads page state.
 */
async function withNotebookLmPage<T>(
  userId: string,
  targetUrl: string,
  evaluate: (page: CdpPage) => Promise<T>,
): Promise<{ result: T; finalUrl: string }> {
  const { apiKey, projectId } = requireBrowserbaseConfig();
  const contextId = await getStoredContextId(userId);

  const sessionRes = await fetch(`${BROWSERBASE_API}/sessions`, {
    method: "POST",
    headers: bbHeaders(apiKey),
    body: JSON.stringify({
      projectId,
      browserSettings: { context: { id: contextId, persist: true } },
      timeout: 60, // this is a quick read, not an interactive login -- no need for a long-lived slot
    }),
  });
  if (!sessionRes.ok) {
    throw new NexusError(
      "notebooklm_browserbase_session_failed",
      `Failed to create a Browserbase session: ${sessionRes.status} ${await sessionRes.text()}`,
      502,
    );
  }
  const session = (await sessionRes.json()) as { id: string; connectUrl?: string };
  if (!session.connectUrl) {
    throw new NexusError(
      "notebooklm_browserbase_session_failed",
      "Browserbase session response had no connectUrl.",
      502,
    );
  }

  try {
    const page = await attachToPage(session.connectUrl);
    await page.command("Page.navigate", { url: targetUrl });
    await page.waitForEvent("Page.loadEventFired", PAGE_LOAD_TIMEOUT_MS);
    // NotebookLM is a client-rendered SPA -- the network "load" event fires
    // before its own JS has actually painted notebook content, so a short
    // fixed buffer after load is the only reliable option here without
    // polling for specific (unverified) DOM markers.
    await new Promise((resolve) => setTimeout(resolve, POST_LOAD_SETTLE_MS));

    const urlRes = await page.command("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
    });
    const finalUrl = String((urlRes.result?.["result"] as { value?: unknown })?.value ?? "");

    const result = await evaluate(page);
    return { result, finalUrl };
  } finally {
    // Best-effort -- a failed release just means the session times out on
    // its own after the short `timeout` set above instead of closing early.
    await fetch(`${BROWSERBASE_API}/sessions/${session.id}`, {
      method: "POST",
      headers: bbHeaders(apiKey),
      body: JSON.stringify({ projectId, status: "REQUEST_RELEASE" }),
    }).catch(() => undefined);
  }
}

async function evaluateJson<T>(page: CdpPage, expression: string): Promise<T> {
  const res = await page.command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  const result = res.result?.["result"] as { value?: unknown; subtype?: string } | undefined;
  if (result?.subtype === "error") {
    throw new NexusError("notebooklm_browserbase_eval_failed", "Failed to read the NotebookLM page.", 502);
  }
  return (result?.value ?? null) as T;
}

export const notebooklmBrowserbaseAdapter = defineAdapter({
  service: "notebooklm-browserbase",
  label: "NotebookLM (your Browserbase login)",
  description:
    "Reads real NotebookLM data using the login captured on /notebooks/connect (Browserbase), " +
    "instead of the separate, unconfigured notebooklm-native/PleasePrompto integration.",
  status: "partial",
  statusNote:
    "Only get_health and list_notebooks are implemented -- reading a notebook's real title/URL " +
    "list. Asking questions, adding sources, and generating audio are not implemented: they'd " +
    "require guessing at NotebookLM's live DOM structure with no way to verify it, which risks " +
    "silent failures or (for asking questions specifically) plausible-looking fabricated answers. " +
    "Requires BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID set as env vars on this app.",
  requiresGoogleAuth: false,
  docsUrl: "https://docs.browserbase.com",
  capabilities: [
    defineCapability({
      id: "notebooklm_browserbase.get_health",
      title: "Check NotebookLM login (Browserbase)",
      description:
        "Opens the saved NotebookLM login in a real (throwaway) browser session and reports " +
        "whether it's still authenticated, based on whether Google bounced it to a login page.",
      implementation: "browser-automation",
      scopes: [],
      input: z.object({}),
      run: async (ctx) => {
        const { finalUrl } = await withNotebookLmPage(ctx.userId, NOTEBOOKLM_URL, async () => null);
        const authenticated =
          finalUrl.startsWith(NOTEBOOKLM_URL) && !finalUrl.includes("accounts.google.com");
        return {
          authenticated,
          finalUrl,
          note: authenticated
            ? "Session is authenticated."
            : "Google redirected away from NotebookLM -- the saved login has likely expired. " +
              "Reconnect via /notebooks/connect.",
        };
      },
    }),
    defineCapability({
      id: "notebooklm_browserbase.list_notebooks",
      title: "List NotebookLM notebooks (Browserbase)",
      description:
        "Lists notebooks visible on the NotebookLM homepage for the connected account, read from " +
        "real notebook links (/notebook/<id>) on the live page.",
      implementation: "browser-automation",
      scopes: [],
      input: z.object({}),
      run: async (ctx) => {
        const { result, finalUrl } = await withNotebookLmPage(ctx.userId, NOTEBOOKLM_URL, (page) =>
          evaluateJson<Array<{ id: string; title: string }>>(
            page,
            `(() => {
              const seen = new Map();
              for (const a of document.querySelectorAll('a[href*="/notebook/"]')) {
                const match = a.href.match(/\\/notebook\\/([a-zA-Z0-9_-]+)/);
                if (!match) continue;
                const id = match[1];
                const title = (a.textContent || "").trim();
                if (!seen.has(id) || (title && !seen.get(id).title)) {
                  seen.set(id, { id, title });
                }
              }
              return Array.from(seen.values());
            })()`,
          ),
        );
        if (finalUrl.includes("accounts.google.com")) {
          throw new NexusError(
            "notebooklm_not_connected",
            "The saved NotebookLM login has expired (Google redirected to a login page). " +
              "Reconnect via /notebooks/connect.",
            412,
          );
        }
        return { notebooks: result, count: result.length };
      },
    }),
  ],
});

export default notebooklmBrowserbaseAdapter;
