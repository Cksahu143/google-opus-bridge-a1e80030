import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { runNexusCapability } from "@/lib/nexus/nexus.functions";

// Google OAuth cannot run inside an embedded user-agent/iframe. Steel's
// interactive debug URL is still used, but the Google login must open in a
// normal top-level browser tab/window.

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

function makeInteractiveLiveViewUrl(value: string): string {
  const url = new URL(value, window.location.origin);
  url.searchParams.set("interactive", "true");
  url.searchParams.set("showControls", "true");
  return url.toString();
}

function ConnectNotebookLmPage() {
  const [state, setState] = useState<ConnectState>({ step: "checking" });
  const [userId, setUserId] = useState<string | null>(null);
  const callCapability = useServerFn(runNexusCapability);

  const [toolState, setToolState] = useState<
    | { kind: "idle" }
    | { kind: "running"; tool: "health" | "list" }
    | { kind: "result"; tool: "health" | "list"; data: unknown }
    | { kind: "tool-error"; tool: "health" | "list"; message: string }
  >({ kind: "idle" });

  async function runTool(tool: "health" | "list") {
    setToolState({ kind: "running", tool });
    const capabilityId =
      tool === "health" ? "notebooklm_steel.get_health" : "notebooklm_steel.list_notebooks";
    try {
      const result = await callCapability({ data: { capabilityId, input: {} } });
      if (!result.ok) throw new Error(result.error ?? "Request failed");
      setToolState({ kind: "result", tool, data: JSON.parse(result.resultJson as string) });
    } catch (err) {
      setToolState({ kind: "tool-error", tool, message: String((err as Error)?.message ?? err) });
    }
  }

  const sessionIdRef = useRef<string | null>(null);

  async function authHeader(): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function checkStatus() {
    try {
      const headers = await authHeader();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/steel-login/status`, { headers });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { status: string; connected_at: string | null };
      setState(
        data.status === "connected"
          ? { step: "connected", connectedAt: data.connected_at }
          : { step: "idle" },
      );
    } catch (err) {
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
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/steel-login/start`, {
        method: "POST",
        headers,
      });
      if (!res.ok) throw new Error(await res.text());
      const { sessionId, liveViewUrl } = await res.json();
      if (!liveViewUrl || typeof liveViewUrl !== "string") {
        throw new Error(
          "Steel did not return a live view URL. Check that STEEL_API_KEY is set as a secret on " +
            "the steel-login Edge Function specifically (Supabase dashboard → Edge Functions → " +
            "steel-login → Secrets).",
        );
      }
      sessionIdRef.current = sessionId;
      setState({
        step: "awaiting-login",
        sessionId,
        liveViewUrl: makeInteractiveLiveViewUrl(liveViewUrl),
      });
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
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/steel-login/complete`, {
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
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/steel-login/disconnect`, {
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
          This connects your real NotebookLM account. Google sign-in opens in a normal browser
          window because Google blocks OAuth login inside embedded browsers.
        </p>
      </div>

      {state.step === "checking" && (
        <p className="text-sm text-muted-foreground">Checking connection status…</p>
      )}
      {state.step === "idle" && (
        <Button onClick={startConnect} disabled={!userId}>Connect NotebookLM</Button>
      )}
      {state.step === "starting" && (
        <p className="text-sm text-muted-foreground">Starting a secure login session…</p>
      )}

      {state.step === "awaiting-login" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-5 space-y-4">
            <div>
              <p className="text-sm font-medium text-foreground">Secure Google login</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Google does not allow account sign-in from an embedded iframe. Open the Steel
                browser in a normal browser tab, complete the login there, then return here.
              </p>
            </div>
            <Button
              type="button"
              onClick={() => window.open(state.liveViewUrl, "steel-notebooklm-login", "popup,width=1200,height=800")}
            >
              Open secure login
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            After the Steel browser shows your NotebookLM notebooks, return to this page and tap
            the button below. Your Google password is entered only in Google&apos;s browser page,
            not into this app.
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
        <div className="space-y-4">
          <p className="text-sm text-foreground">
            NotebookLM connected
            {state.connectedAt ? ` — since ${new Date(state.connectedAt).toLocaleString()}` : ""}.
          </p>
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">
              Try the actual tools Claude uses against this login:
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void runTool("health")}
                disabled={toolState.kind === "running"}
              >
                {toolState.kind === "running" && toolState.tool === "health" ? "Checking…" : "Check login is still valid"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void runTool("list")}
                disabled={toolState.kind === "running"}
              >
                {toolState.kind === "running" && toolState.tool === "list" ? "Loading…" : "List my real notebooks"}
              </Button>
            </div>
            {toolState.kind === "result" && (
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(toolState.data, null, 2)}
              </pre>
            )}
            {toolState.kind === "tool-error" && (
              <p role="alert" className="text-xs text-destructive">{toolState.message}</p>
            )}
          </div>
          <Button type="button" variant="outline" onClick={disconnect}>Disconnect NotebookLM</Button>
        </div>
      )}

      {state.step === "disconnecting" && (
        <p className="text-sm text-muted-foreground">Disconnecting…</p>
      )}
      {state.step === "error" && (
        <p role="alert" className="text-sm text-destructive">{state.message}</p>
      )}
    </main>
  );
}
