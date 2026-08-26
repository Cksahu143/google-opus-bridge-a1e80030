import { z } from "zod";

import { NexusError } from "@/lib/nexus/errors";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * NotebookLM integration backed by the SAME Steel-captured login the user
 * creates on /notebooks/connect (notebooklm_connections + Vault-stored
 * session state, wired up by the steel-login Edge Function). Replaces the
 * earlier Browserbase-backed version of this adapter after the login
 * backend was switched to Steel per user-reported slowness/disconnects
 * with Browserbase — kept the old one around would have meant it silently
 * stopped working the moment steel-login stopped populating
 * browserbase_contexts, which is exactly the kind of dead-parallel-code
 * confusion found and cleaned up multiple times already in this repo.
 *
 * Scope, honestly, unchanged from the Browserbase version: only
 * get_health and list_notebooks are implemented. NotebookLM's real page
 * structure (for asking questions, adding sources, generating audio) is
 * not something this adapter's author can inspect or test live — guessing
 * at DOM selectors for those would risk either silent failures or, worse
 * for `ask`, plausible-looking but fabricated answers. list_notebooks
 * only reads notebook links by URL pattern (/notebook/<id>), a stable,
 * documented NotebookLM URL convention rather than a guessed CSS
 * selector, so it's a much safer bet.
 *
 * Requires STEEL_API_KEY as an environment variable on THIS app (Lovable
 * project env vars) — a separate secret store from the Supabase Edge
 * Function secret already configured for steel-login. Same free Steel
 * account, just needs the same value set again here.
 */

const STEEL_API = "https://api.steel.dev/v1";
const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const CDP_TIMEOUT_MS = 8_000;
const PAGE_LOAD_TIMEOUT_MS = 15_000;
const POST_LOAD_SETTLE_MS = 1_500;

function requireSteelConfig(): { apiKey: string } {
  const apiKey = process.env["STEEL_API_KEY"]?.trim();
  if (!apiKey) {
    throw new NexusError(
      "notebooklm_steel_not_configured",
      "STEEL_API_KEY must be set as an environment variable on this app (separate from the " +
        "same-named Supabase Edge Function secret already configured for steel-login — Lovable " +
        "env vars are a different store).",
      503,
    );
  }
  return { apiKey };
}

function steelHeaders(apiKey: string): Record<string, string> {
  // Confirmed directly from Steel's own auth docs: send the key in the
  // steel-api-key header (lowercase) for direct REST calls.
  return { "steel-api-key": apiKey, "content-type": "application/json" };
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** The exported cookie/localStorage state saved when the user logged in via /notebooks/connect. */
async function getSavedState(userId: string): Promise<unknown> {
  const db = await admin();
  const secretName = `steel_session_state_${userId}`;
  const { data: decrypted, error } = await db.rpc("vault_read_secret_by_name", {
    secret_name: secretName,
  });
  if (error) throw error;
  if (!decrypted) {
    throw new NexusError(
      "notebooklm_not_connected",
      "No NotebookLM login found for this user. Visit /notebooks/connect and log in first.",
      412,
    );
  }
  try {
    return JSON.parse(decrypted as string);
  } catch {
    throw new NexusError(
      "notebooklm_saved_state_corrupt",
      "The saved NotebookLM login could not be read. Reconnect via /notebooks/connect.",
      500,
    );
  }
}

// --- Minimal CDP client (same technique as steel-login's Edge Function
// /type endpoint, reimplemented here since this runs in a separate Node
// process with its own module scope, not Deno). ---

interface CdpPage {
  ws: WebSocket;
  command: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<{ result?: Record<string, unknown> }>;
  waitForEvent: (method: string, timeoutMs: number) => Promise<void>;
}

async function attachToPage(wsUrl: string): Promise<CdpPage> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Failed to open CDP WebSocket to Steel session"));
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
  if (!pageTarget) throw new Error("No page target found on the Steel session");

  const attachRes = await waitFor(
    send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true }),
  );
  const pageSessionId = attachRes.result?.["sessionId"] as string | undefined;
  if (!pageSessionId) throw new Error("Failed to attach to the Steel session's page target");

  const page: CdpPage = {
    ws,
    command: (method, params = {}) => waitFor(send(method, params, pageSessionId)),
    waitForEvent: (method, timeoutMs) =>
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs); // timeout resolves too -- best-effort wait
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
 * Opens a short-lived Steel session pre-loaded with the user's saved
 * NotebookLM cookie state, navigates to a URL, waits for it to settle,
 * runs `evaluate` against the live page, then always releases the session.
 * Read-only by design -- this never types anything or clicks anything,
 * only reads page state.
 */
async function withNotebookLmPage<T>(
  userId: string,
  targetUrl: string,
  evaluate: (page: CdpPage) => Promise<T>,
): Promise<{ result: T; finalUrl: string }> {
  const { apiKey } = requireSteelConfig();
  const state = await getSavedState(userId);

  const sessionRes = await fetch(`${STEEL_API}/sessions`, {
    method: "POST",
    headers: steelHeaders(apiKey),
    body: JSON.stringify({ state, timeout: 60_000 }), // quick read, not an interactive login
  });
  if (!sessionRes.ok) {
    throw new NexusError(
      "notebooklm_steel_session_failed",
      `Failed to create a Steel session: ${sessionRes.status} ${await sessionRes.text()}`,
      502,
    );
  }
  const session = (await sessionRes.json()) as { id: string; websocketUrl?: string };
  if (!session.websocketUrl) {
    throw new NexusError(
      "notebooklm_steel_session_failed",
      "Steel session response had no websocketUrl.",
      502,
    );
  }

  try {
    const page = await attachToPage(session.websocketUrl);
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
    // its own after the short timeout set above instead of closing early.
    await fetch(`${STEEL_API}/sessions/${session.id}/release`, {
      method: "POST",
      headers: steelHeaders(apiKey),
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
    throw new NexusError(
      "notebooklm_steel_eval_failed",
      "Failed to read the NotebookLM page.",
      502,
    );
  }
  return (result?.value ?? null) as T;
}

export const notebooklmSteelAdapter = defineAdapter({
  service: "notebooklm-steel",
  label: "NotebookLM (your Steel login)",
  description:
    "Reads real NotebookLM data using the login captured on /notebooks/connect (Steel), " +
    "instead of the separate, unconfigured notebooklm-native/PleasePrompto integration.",
  status: "partial",
  statusNote:
    "Only get_health and list_notebooks are implemented -- reading a notebook's real title/URL " +
    "list. Asking questions, adding sources, and generating audio are not implemented: they'd " +
    "require guessing at NotebookLM's live DOM structure with no way to verify it, which risks " +
    "silent failures or (for asking questions specifically) plausible-looking fabricated answers. " +
    "Requires STEEL_API_KEY set as an env var on this app.",
  requiresGoogleAuth: false,
  docsUrl: "https://docs.steel.dev",
  capabilities: [
    defineCapability({
      id: "notebooklm_steel.get_health",
      title: "Check NotebookLM login (Steel)",
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
      id: "notebooklm_steel.list_notebooks",
      title: "List NotebookLM notebooks (Steel)",
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

export default notebooklmSteelAdapter;
