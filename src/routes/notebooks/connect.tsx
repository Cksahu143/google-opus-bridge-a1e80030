import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

// The actual browser doing the Google/NotebookLM login runs on
// Browserbase's managed infrastructure. Opened as a real new browser tab
// (window.open) rather than an embedded iframe -- this is both faster
// (no streaming-into-an-iframe overhead) and means the user types
// directly into a normal page, so no CDP text-forwarding workaround is
// needed for iPad/iPhone (that was only ever required because iOS Safari
// won't raise a keyboard for an element inside a remote/screencast
// iframe -- a real tab doesn't have that problem at all).
//
// KNOWN LIMITATION: only one login session can be in progress at a time
// per user (Browserbase's free tier also caps sessions at 15 minutes and
// ~1 browser-hour/month total -- fine for occasional logins, not for
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
// authenticated with the signed-in user's own JWT (see authHeader()).
// Derived from the project's Supabase URL so there is no extra env var to
// forget (VITE_SUPABASE_FUNCTIONS_URL still wins if it's set explicitly).
const SUPABASE_FUNCTIONS_URL =
  (import.meta.env["VITE_SUPABASE_FUNCTIONS_URL"] as string | undefined) ??
  `${(import.meta.env["VITE_SUPABASE_URL"] as string | undefined) ?? ""}/functions/v1`;

type ConnectState =
  | { step: "checking" }
  | { step: "idle" }
  | { step: "starting" }
  | { step: "awaiting-login"; sessionId: string; liveViewUrl: string; opened: boolean }
  | { step: "completing"; sessionId: string }
  | { step: "connected"; connectedAt: string | null }
  | { step: "disconnecting" }
  | { step: "error"; message: string };

function ConnectNotebookLmPage() {
  const [state, setState] = useState<ConnectState>({ step: "checking" });
  const [userId, setUserId] = useState<string | null>(null);
  // Track the in-flight sessionId only so an unmount mid-login doesn't
  // leave a dangling reference client-side. Browserbase sessions expire on
  // their own (15 min on the free tier) -- there's no cancel call to make.
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
      // Not fatal -- just fall back to showing the connect button rather
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Explicit lock, separate from React state: a synchronous ref actually
  // blocks a rapid double-tap before React re-renders the button as
  // disabled, unlike setState -- confirmed necessary via Supabase logs
  // earlier showing two /start calls fire under 1 second apart from a
  // single interaction, each burning one of only 3 free-tier concurrent
  // session slots.
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
        throw new Error(
          "Browserbase did not return a live view URL. Check that BROWSERBASE_API_KEY and " +
            "BROWSERBASE_PROJECT_ID are set as secrets on the browserbase-login Edge Function " +
            "specifically (Supabase dashboard → Edge Functions → browserbase-login → Secrets) " +
            "— a Lovable frontend env var alone is not visible to this function.",
        );
      }
      sessionIdRef.current = sessionId;
      // Open immediately, inside the same user gesture (tapping "Connect")
      // that triggered startConnect -- iOS Safari blocks window.open calls
      // that happen after an await unless they're still within the
      // original tap's event, so this fires right as the response lands
      // rather than after further async work.
      const opened = window.open(liveViewUrl, "_blank", "noopener,noreferrer");
      setState({ step: "awaiting-login", sessionId, liveViewUrl, opened: Boolean(opened) });
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
          elsewhere in this app). You&apos;ll log into Google in a new tab.
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
          {!state.opened && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-sm text-foreground">
                Your browser blocked the automatic pop-up. Tap the button below to open it manually:
              </p>
              <Button
                type="button"
                onClick={() => window.open(state.liveViewUrl, "_blank", "noopener,noreferrer")}
              >
                Open login in a new tab
              </Button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Log into your Google account in that tab — type normally there, just like any website.
            Once you see your NotebookLM notebooks load, come back to this tab and tap below.
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
