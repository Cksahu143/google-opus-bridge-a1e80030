import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

// UNTESTED — written for review. Requires BROWSERBASE_API_KEY and
// BROWSERBASE_PROJECT_ID to be set as secrets on the browserbase-login
// Supabase edge function before this page will actually work (free
// account at browserbase.com, no card required).
//
// The actual browser doing the Google/NotebookLM login runs on
// Browserbase's managed infrastructure, streamed into this page via an
// iframe pointed at their Live View URL. This replaces an earlier
// self-hosted Docker/Xvfb/noVNC container (login-service/ in the repo
// root) that was never deployed, so the old version of this page could
// not actually complete a login. No self-hosting is required now.
//
// KNOWN LIMITATION: only one login session can be in progress at a time
// per user (Browserbase's free tier also caps sessions at 15 minutes and
// ~1 browser-hour/month total — fine for occasional logins, not for
// anything continuous).
//
// iPad/iPhone typing: iOS/iPadOS Safari will not raise its virtual
// keyboard for an element inside the live-view iframe -- there's no local
// DOM input for it to attach to, since the actual login form lives inside
// Browserbase's remote browser, not on the device. The "Type into
// browser" box below is a real local input (so iOS *will* show a
// keyboard for it); typing there and tapping Send forwards the text into
// whatever field is currently focused in the live view via the backend's
// CDP bridge. Tap the field in the live view first to focus it, same as
// any login form.

export const Route = createFileRoute("/notebooks/connect")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Connect NotebookLM · Google Nexus" },
      {
        name: "description",
        content:
          "Connect your real NotebookLM account so Claude can create and manage real notebooks.",
      },
    ],
  }),
  component: ConnectNotebookLmPage,
});

// Base URL for this project's Supabase Edge Functions. All of /start,
// /type, /complete, /disconnect and /status go through browserbase-login,
// authenticated with the signed-in user's own JWT (see authHeader()) —
// there is no longer a separate, unauthenticated login-service to call.
// Derived from the project's Supabase URL so there is no extra env var to
// forget (VITE_SUPABASE_FUNCTIONS_URL still wins if it's set explicitly).
const SUPABASE_FUNCTIONS_URL =
  (import.meta.env["VITE_SUPABASE_FUNCTIONS_URL"] as string | undefined) ??
  `${(import.meta.env["VITE_SUPABASE_URL"] as string | undefined) ?? ""}/functions/v1`;

type ConnectState =
  | { step: "checking" }
  | { step: "idle" }
  | { step: "starting" }
  | { step: "awaiting-login"; sessionId: string; liveViewUrl: string }
  | { step: "completing"; sessionId: string }
  | { step: "connected"; connectedAt: string | null }
  | { step: "disconnecting" }
  | { step: "error"; message: string };

function ConnectNotebookLmPage() {
  const [state, setState] = useState<ConnectState>({ step: "checking" });
  const [userId, setUserId] = useState<string | null>(null);
  // Track the in-flight sessionId only so an unmount mid-login doesn't
  // leave a dangling reference client-side. Browserbase sessions expire on
  // their own (15 min on the free tier) — there's no cancel call to make.
  const sessionIdRef = useRef<string | null>(null);

  // Local "type into browser" box state -- see the file header comment on
  // why this exists (iOS won't show a keyboard for the remote page).
  const [typeValue, setTypeValue] = useState("");
  const [typing, setTyping] = useState(false);

  async function authHeader(): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function checkStatus() {
    try {
      const headers = await authHeader();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/browserbase-login/status`, { headers });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { status: string; connected_at: string | null };
      setState(
        data.status === "connected"
          ? { step: "connected", connectedAt: data.connected_at }
          : { step: "idle" },
      );
    } catch (err) {
      // Not fatal — just fall back to showing the connect button rather
      // than blocking the page on a status-check failure.
      setState({ step: "idle" });
      console.error("Failed to check NotebookLM connection status:", err);
    }
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
      void checkStatus();
    });
  }, []);

  // Explicit lock, separate from React state: the logs showed two /start
  // calls firing 0.7s apart from a single interaction, each burning one of
  // only 3 free-tier concurrent session slots. A ref updates synchronously,
  // unlike setState, so this actually blocks the second call rather than
  // hoping the button disables in time.
  const startInFlightRef = useRef(false);

  async function startConnect() {
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
    if (!userId) {
      setState({ step: "error", message: "You must be signed in to connect NotebookLM." });
      startInFlightRef.current = false;
      return;
    }
    setState({ step: "starting" });
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) };
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/browserbase-login/start`, {
        method: "POST",
        headers,
      });
      if (!res.ok) throw new Error(await res.text());
      const { sessionId, liveViewUrl } = await res.json();
      if (!liveViewUrl || typeof liveViewUrl !== "string") {
        // This is the actual "about:blank" bug: previously we'd set
        // liveViewUrl into state even if it came back empty/undefined,
        // and <iframe src={undefined}> silently renders about:blank with
        // no visible error at all. Fail loudly instead.
        throw new Error(
          "Browserbase did not return a live view URL. Check that BROWSERBASE_API_KEY and " +
            "BROWSERBASE_PROJECT_ID are set as secrets on the browserbase-login Edge Function " +
            "specifically (Supabase dashboard → Edge Functions → browserbase-login → Secrets) " +
            "— a Lovable frontend env var alone is not visible to this function.",
        );
      }
      sessionIdRef.current = sessionId;
      setState({ step: "awaiting-login", sessionId, liveViewUrl });
    } catch (err) {
      setState({ step: "error", message: String((err as Error)?.message ?? err) });
    } finally {
      startInFlightRef.current = false;
    }
  }

  // Forwards the local text box's value into the remote page's currently
  // focused field, and optionally presses Enter. See the file header
  // comment for why this exists (iOS won't raise a keyboard inside the
  // live-view iframe). Clears the box afterward so it's ready for the
  // next field (e.g. password, after email).
  // Same class of bug as startInFlightRef above, same fix: React's `typing`
  // state alone doesn't block a fast double-tap on "Send" (setState is
  // async/batched — two touch events can both fire before the button
  // re-renders as disabled). On this endpoint specifically, that means two
  // simultaneous attachToPage() WebSocket connections opening against the
  // same session — which is precisely what the /type handler's own file
  // comment already identifies as the cause of "WebSocket disconnected"
  // mid-login. A synchronous ref actually blocks the second call.
  const typingInFlightRef = useRef(false);

  async function sendTypedText(pressEnter: boolean) {
    if (state.step !== "awaiting-login") return;
    if (!typeValue && !pressEnter) return;
    if (typingInFlightRef.current) return;
    typingInFlightRef.current = true;
    setTyping(true);
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) };
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/browserbase-login/type`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId: state.sessionId, text: typeValue, pressEnter }),
      });
      if (!res.ok) throw new Error(await res.text());
      setTypeValue("");
    } catch (err) {
      setState({ step: "error", message: String((err as Error)?.message ?? err) });
    } finally {
      setTyping(false);
      typingInFlightRef.current = false;
    }
  }

  async function finishConnect(sessionId: string) {
    setState({ step: "completing", sessionId });
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) };
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/browserbase-login/complete`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) throw new Error(await res.text());
      sessionIdRef.current = null;
      setState({ step: "connected", connectedAt: new Date().toISOString() });
    } catch (err) {
      setState({ step: "error", message: String((err as Error)?.message ?? err) });
    }
  }

  async function disconnect() {
    setState({ step: "disconnecting" });
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) };
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/browserbase-login/disconnect`, {
        method: "POST",
        headers,
      });
      if (!res.ok) throw new Error(await res.text());
      setState({ step: "idle" });
    } catch (err) {
      setState({ step: "error", message: String((err as Error)?.message ?? err) });
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-16">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
          Google Nexus
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          Connect NotebookLM
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This connects your real NotebookLM account (not the separate Nexus-managed notebooks used
          elsewhere in this app). You&apos;ll log into Google in the embedded window below.
        </p>
      </div>

      {state.step === "checking" && (
        <p className="text-sm text-muted-foreground">Checking connection status…</p>
      )}

      {state.step === "idle" && (
        <Button onClick={startConnect} disabled={!userId}>
          Connect NotebookLM
        </Button>
      )}

      {state.step === "starting" && (
        <p className="text-sm text-muted-foreground">Starting a secure login session…</p>
      )}

      {state.step === "awaiting-login" && (
        <div className="space-y-4">
          <div
            className="overflow-hidden rounded-lg border border-border"
            style={{ aspectRatio: "16 / 10" }}
          >
            {/* Real, live browser session running on Browserbase's
                infrastructure — not a screenshot. Tap fields to focus them;
                on iPad/iPhone, type into the box below instead of directly
                in this iframe (see "Can't type?" note below it). */}
            <iframe
              src={state.liveViewUrl}
              title="NotebookLM login"
              className="h-full w-full"
              allow="clipboard-write"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
            />
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">
              Can&apos;t type in the window above? (Common on iPad/iPhone.) Tap the field you want
              to fill in the login window first, then type it here instead:
            </p>
            <div className="flex gap-2">
              <Input
                type="text"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="Type your email or password here…"
                value={typeValue}
                onChange={(e) => setTypeValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void sendTypedText(true);
                  }
                }}
                disabled={typing}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => void sendTypedText(false)}
                disabled={typing || !typeValue}
              >
                Send
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void sendTypedText(true)}
              disabled={typing}
            >
              Press Enter / Next
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            Log into your Google account above. Once you see your NotebookLM notebooks load inside
            the window, tap the button below.
          </p>
          <Button type="button" onClick={() => finishConnect(state.sessionId)}>
            I&apos;m done logging in
          </Button>
        </div>
      )}

      {state.step === "completing" && (
        <p className="text-sm text-muted-foreground">Saving your connection securely…</p>
      )}

      {state.step === "connected" && (
        <div className="space-y-3">
          <p className="text-sm text-foreground">
            NotebookLM connected
            {state.connectedAt ? ` — since ${new Date(state.connectedAt).toLocaleString()}` : ""}.
            Claude can now create and manage your real notebooks.
          </p>
          <Button type="button" variant="outline" onClick={disconnect}>
            Disconnect NotebookLM
          </Button>
        </div>
      )}

      {state.step === "disconnecting" && (
        <p className="text-sm text-muted-foreground">Disconnecting…</p>
      )}

      {state.step === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
    </main>
  );
}
