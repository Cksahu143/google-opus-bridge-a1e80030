import { z } from "zod";

import { NexusError } from "@/lib/nexus/errors";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * General-purpose live browser sessions on Steel -- NOT tied to
 * NotebookLM or any saved login. This is what lets the user literally
 * watch this app drive a browser in real time: every capability here
 * returns (or reuses) a `liveViewUrl` you can open in a tab or embed in
 * an iframe, identical to the Live View used on /notebooks/connect.
 *
 * Unlike notebooklm-steel, sessions here are NOT bound to a persisted
 * profile by default -- each start_session is a fresh, logged-out
 * browser unless the caller explicitly passes a profileId they already
 * have (e.g. reusing the NotebookLM one deliberately).
 *
 * Same session-cache limitation as steel-login and notebooklm-steel:
 * click/type/read reuse ONE attached CDP connection per session via
 * module-level state, which does not survive this function's Deno/Node
 * isolate being recycled between requests. If that happens mid-session,
 * the fix is simply to end_session and start_session again.
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

interface CdpPage {
  ws: WebSocket;
  command: (method: string, params?: Record<string, unknown>) => Promise<{ result?: Record<string, unknown> }>;
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
        const timeout = setTimeout(resolve, timeoutMs);
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
  await page.command("DOM.enable");
  return page;
}

const sessions = new Map<string, CdpPage>();

async function evaluateJson<T>(page: CdpPage, expression: string): Promise<T> {
  const res = await page.command("Runtime.evaluate", { expression, returnByValue: true });
  const result = res.result?.["result"] as { value?: unknown; subtype?: string } | undefined;
  if (result?.subtype === "error") {
    throw new NexusError("steel_browser_eval_failed", "The page script threw an error.", 502);
  }
  return (result?.value ?? null) as T;
}

function requireSession(sessionId: string): CdpPage {
  const page = sessions.get(sessionId);
  if (!page) {
    throw new NexusError(
      "steel_browser_session_not_found",
      "No active session for this sessionId -- either it was never started here, or this " +
        "function instance was recycled between requests. Call start_session again.",
      404,
    );
  }
  return page;
}

export const steelBrowserAdapter = defineAdapter({
  service: "steel-browser",
  label: "Live Browser (Steel)",
  description:
    "General-purpose real browser sessions with a live view you can watch -- navigate, click, " +
    "type, and read pages in real time, not bound to any saved login.",
  status: "partial",
  statusNote:
    "click/type/read reuse one CDP connection per session in memory -- doesn't survive this " +
    "function's isolate being recycled between requests. If a call fails with " +
    "steel_browser_session_not_found, just start_session again. Requires STEEL_API_KEY as an " +
    "env var on this app.",
  requiresGoogleAuth: false,
  docsUrl: "https://docs.steel.dev",
  capabilities: [
    defineCapability({
      id: "steel_browser.start_session",
      title: "Start a live browser session",
      description:
        "Opens a real browser session and navigates to a URL. Returns a liveViewUrl -- open it in " +
        "a tab or embed it in an iframe to watch every action happen in real time.",
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
      run: async (_ctx, input) => {
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
        sessions.set(session.id, page);
        page.ws.addEventListener("close", () => {
          if (sessions.get(session.id) === page) sessions.delete(session.id);
        });

        await page.command("Page.navigate", { url: input.url });
        await page.waitForEvent("Page.loadEventFired", PAGE_LOAD_TIMEOUT_MS);

        return { sessionId: session.id, liveViewUrl: session.sessionViewerUrl };
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
      run: async (_ctx, input) => {
        const page = requireSession(input.sessionId);
        await page.command("Page.navigate", { url: input.url });
        await page.waitForEvent("Page.loadEventFired", PAGE_LOAD_TIMEOUT_MS);
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
      run: async (_ctx, input) => {
        const page = requireSession(input.sessionId);
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
      run: async (_ctx, input) => {
        const page = requireSession(input.sessionId);
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
      run: async (_ctx, input) => {
        const page = requireSession(input.sessionId);
        const text = await evaluateJson<string | null>(
          page,
          input.selector
            ? `document.querySelector(${JSON.stringify(input.selector)})?.innerText ?? null`
            : `document.body.innerText`,
        );
        const urlValue = await evaluateJson<string>(page, "window.location.href");
        return { url: urlValue, text };
      },
    }),
    defineCapability({
      id: "steel_browser.end_session",
      title: "End a live browser session",
      description: "Closes the CDP connection and releases the Steel session.",
      implementation: "browser-automation",
      scopes: [],
      mutating: true,
      input: z.object({ sessionId: z.string() }),
      run: async (_ctx, input) => {
        const { apiKey } = requireSteelConfig();
        const page = sessions.get(input.sessionId);
        if (page) {
          sessions.delete(input.sessionId);
          try {
            page.ws.close();
          } catch {
            // already closed -- fine
          }
        }
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
