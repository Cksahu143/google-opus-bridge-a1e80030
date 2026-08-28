import { z } from "zod";

import { NexusError } from "@/lib/nexus/errors";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * General-purpose live browser sessions on Steel -- NOT tied to
 * NotebookLM or any saved login.
 *
 * ARCHITECTURE -- CONFIRMED BY LIVE TEST (twice-revised):
 * Attempt 1 kept the CDP WebSocket connection in an in-memory Map
 * across separate tool calls. Failed instantly: this app runs as a
 * stateless serverless invocation, so nothing in memory survives
 * between calls.
 * Attempt 2 persisted the session's websocketUrl in Supabase and
 * opened a fresh WebSocket per call. Failed with a distinct error:
 * "Cannot perform I/O on behalf of a different request" -- Cloudflare
 * Workers forbids reusing any I/O resource tied to a given URL across
 * separate request contexts, which a reconnect-per-call design runs
 * straight into.
 * Steel's own REST "Actions API" (scrape/screenshot/pdf) is explicitly
 * documented as read-only/on-demand -- there is no REST click or type
 * endpoint. Interactive control fundamentally requires one continuous
 * CDP connection.
 *
 * FIX: stop splitting click/type/read into separate tool calls. A
 * single capability (run_actions) takes an ORDERED LIST of steps,
 * opens exactly one CDP WebSocket, runs every step against it in
 * sequence, then closes it -- all inside one request/invocation. This
 * satisfies Cloudflare's per-request I/O isolation instead of fighting
 * it, while still giving genuine multi-step interactivity (click, type,
 * wait, read) in one call.
 *
 * The trade-off: you plan a short sequence of actions per call instead
 * of steering one action at a time. For most real tasks (search box +
 * submit, login form, etc.) this is a completely natural fit anyway.
 *
 * Steel's sessionViewerUrl still cannot be embedded in an iframe --
 * confirmed by live test, Steel sends its own frame-ancestors headers.
 * Open it as a top-level tab.
 *
 * Requires STEEL_API_KEY as an environment variable on this app.
 */

const STEEL_API = "https://api.steel.dev/v1";
const CDP_TIMEOUT_MS = 8_000;
const PAGE_LOAD_TIMEOUT_MS = 15_000;
const MAX_STEPS = 12;

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

interface CdpPage {
  command: (method: string, params?: Record<string, unknown>) => Promise<{ result?: Record<string, unknown> }>;
  waitForEvent: (method: string, timeoutMs: number) => Promise<void>;
  close: () => void;
}

/** Opens a CDP connection for the lifetime of ONE request. Caller must call page.close() before returning. */
async function attachToPage(wsUrl: string): Promise<CdpPage> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () =>
      reject(new NexusError("steel_browser_connect_failed", "Failed to open CDP WebSocket to the Steel session -- it may have expired.", 502));
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

async function clickSelector(page: CdpPage, selector: string) {
  const rect = await evaluateJson<{ x: number; y: number } | null>(
    page,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
  if (!rect) {
    throw new NexusError("steel_browser_element_not_found", `No element matched "${selector}".`, 404);
  }
  await page.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await page.command("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await page.command("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
}

async function typeText(page: CdpPage, text: string, pressEnter: boolean) {
  if (text) await page.command("Input.insertText", { text });
  if (pressEnter) {
    const enterParams = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" };
    await page.command("Input.dispatchKeyEvent", { type: "keyDown", ...enterParams });
    await page.command("Input.dispatchKeyEvent", { type: "keyUp", ...enterParams });
  }
}

const stepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.string().url() }),
  z.object({ action: z.literal("click"), selector: z.string().min(1) }),
  z.object({ action: z.literal("type"), text: z.string(), pressEnter: z.boolean().default(false) }),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(0).max(10_000) }),
  z.object({ action: z.literal("read"), selector: z.string().optional() }),
]);

export const steelBrowserAdapter = defineAdapter({
  service: "steel-browser",
  label: "Live Browser (Steel)",
  description:
    "General-purpose real browser sessions with a live view you can watch -- run an ordered " +
    "sequence of navigate/click/type/wait/read actions in one call.",
  status: "partial",
  statusNote:
    "Actions must be batched into one run_actions call per session (max " + String(MAX_STEPS) + " steps) " +
    "because Cloudflare Workers forbids reusing a CDP WebSocket connection across separate request " +
    "invocations, and Steel's REST API has no click/type endpoints (only read-only " +
    "scrape/screenshot/pdf) -- confirmed by live test after two earlier architectures both failed. " +
    "The returned liveViewUrl only works opened as a top-level tab, not embedded in an iframe -- " +
    "also confirmed by live test. Requires STEEL_API_KEY as an env var on this app.",
  requiresGoogleAuth: false,
  docsUrl: "https://docs.steel.dev",
  capabilities: [
    defineCapability({
      id: "steel_browser.run_actions",
      title: "Run a sequence of live browser actions",
      description:
        "Starts a fresh live browser session (or reuses one if steelSessionId + steelWebsocketUrl " +
        "from a PRIOR run_actions response are passed back in) and runs an ordered list of actions " +
        "against it in a single call: navigate, click, type, wait, or read. Returns a liveViewUrl to " +
        "open in its own tab to watch, plus the outcome of any 'read' steps, plus steelSessionId/" +
        "steelWebsocketUrl to continue the SAME session in a later call. Max " + String(MAX_STEPS) + " steps per call.",
      implementation: "browser-automation",
      scopes: [],
      mutating: true,
      input: z.object({
        url: z.string().url().optional().describe("Starting URL. Required when not continuing an existing session."),
        steelSessionId: z.string().optional().describe("Continue a session from a prior run_actions response."),
        steelWebsocketUrl: z.string().optional().describe("The websocketUrl from a prior run_actions response, required together with steelSessionId."),
        profileId: z.string().optional().describe("Reuse a previously saved Steel profile instead of starting logged-out. Only used when starting a new session."),
        steps: z.array(stepSchema).min(1).max(MAX_STEPS),
      }),
      run: async (_ctx, input) => {
        const { apiKey } = requireSteelConfig();

        let steelSessionId = input.steelSessionId;
        let websocketUrl = input.steelWebsocketUrl;
        let liveViewUrl: string | undefined;

        if (!steelSessionId || !websocketUrl) {
          if (!input.url) {
            throw new NexusError("steel_browser_bad_input", "url is required when not continuing an existing session.", 400);
          }
          const sessionRes = await fetch(`${STEEL_API}/sessions`, {
            method: "POST",
            headers: steelHeaders(apiKey),
            body: JSON.stringify(input.profileId ? { profileId: input.profileId, persistProfile: true } : {}),
          });
          if (!sessionRes.ok) {
            throw new NexusError(
              "steel_browser_session_failed",
              `Failed to create a Steel session: ${sessionRes.status} ${await sessionRes.text()}`,
              502,
            );
          }
          const session = (await sessionRes.json()) as { id: string; sessionViewerUrl?: string; websocketUrl?: string };
          if (!session.sessionViewerUrl || !session.websocketUrl) {
            throw new NexusError("steel_browser_session_failed", "Steel session response was incomplete.", 502);
          }
          steelSessionId = session.id;
          websocketUrl = session.websocketUrl;
          liveViewUrl = session.sessionViewerUrl;
          input.steps.unshift({ action: "navigate", url: input.url });
        } else {
          liveViewUrl = `https://app.steel.dev/sessions/${steelSessionId}`;
        }

        const page = await attachToPage(websocketUrl);
        const reads: Array<{ url: string; text: string | null }> = [];
        try {
          for (const step of input.steps) {
            switch (step.action) {
              case "navigate":
                await page.command("Page.navigate", { url: step.url });
                await page.waitForEvent("Page.loadEventFired", PAGE_LOAD_TIMEOUT_MS);
                break;
              case "click":
                await clickSelector(page, step.selector);
                break;
              case "type":
                await typeText(page, step.text, step.pressEnter);
                break;
              case "wait":
                await new Promise((resolve) => setTimeout(resolve, step.ms));
                break;
              case "read": {
                const text = await evaluateJson<string | null>(
                  page,
                  step.selector
                    ? `document.querySelector(${JSON.stringify(step.selector)})?.innerText ?? null`
                    : `document.body.innerText`,
                );
                const urlValue = await evaluateJson<string>(page, "window.location.href");
                reads.push({ url: urlValue, text });
                break;
              }
            }
          }
        } finally {
          page.close();
        }

        return {
          steelSessionId,
          steelWebsocketUrl: websocketUrl,
          liveViewUrl,
          liveViewNote: "Open this URL in its own browser tab. It will not render inside an embedded iframe.",
          reads,
        };
      },
    }),
    defineCapability({
      id: "steel_browser.end_session",
      title: "End a live browser session",
      description: "Releases a session on Steel. Pass the steelSessionId from a run_actions response.",
      implementation: "browser-automation",
      scopes: [],
      mutating: true,
      input: z.object({ steelSessionId: z.string() }),
      run: async (_ctx, input) => {
        const { apiKey } = requireSteelConfig();
        await fetch(`${STEEL_API}/sessions/${input.steelSessionId}/release`, {
          method: "POST",
          headers: steelHeaders(apiKey),
        }).catch(() => undefined);
        return { ok: true };
      },
    }),
  ],
});

export default steelBrowserAdapter;
