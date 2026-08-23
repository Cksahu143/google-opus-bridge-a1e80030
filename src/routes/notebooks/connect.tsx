import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
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
// /complete, /disconnect and /status go through browserbase-login,
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
          elsewhere in this app). You&apos;ll log into Google in the embedded window below — works
          the same on iPad, iPhone, or desktop, since it&apos;s a regular web page, not a native
          login.
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
                infrastructure — not a screenshot. The user can tap/type in
                it directly, same as any other login page. */}
            <iframe
              src={state.liveViewUrl}
              title="NotebookLM login"
              className="h-full w-full"
              allow="clipboard-write"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Log into your Google account above. Once you see your NotebookLM notebooks load inside
            the window, tap the button below.
          </p>
          <Button onClick={() => finishConnect(state.sessionId)}>I&apos;m done logging in</Button>
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
          <Button variant="outline" onClick={disconnect}>
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
