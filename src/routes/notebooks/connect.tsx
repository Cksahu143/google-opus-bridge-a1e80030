import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/notebooks/connect")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Connect NotebookLM · Google Nexus" },
      {
        name: "description",
        content: "Connect Google Nexus to NotebookLM through a server-side browser gateway.",
      },
    ],
  }),
  component: ConnectNotebookLmPage,
});

const SUPABASE_FUNCTIONS_URL =
  (import.meta.env["VITE_SUPABASE_FUNCTIONS_URL"] as string | undefined) ??
  `${(import.meta.env["VITE_SUPABASE_URL"] as string | undefined) ?? ""}/functions/v1`;

type State =
  | { step: "checking" }
  | { step: "offline"; message?: string }
  | { step: "ready"; providers?: Record<string, boolean> };

type ToolState =
  | { kind: "idle" }
  | { kind: "running"; tool: "health" | "start" | "inspect" | "stop" }
  | { kind: "result"; tool: "health" | "start" | "inspect" | "stop"; data: unknown }
  | { kind: "error"; tool: "health" | "start" | "inspect" | "stop"; message: string };

function ConnectNotebookLmPage() {
  const [state, setState] = useState<State>({ step: "checking" });
  const [userId, setUserId] = useState<string | null>(null);
  const [toolState, setToolState] = useState<ToolState>({ kind: "idle" });

  async function authHeaders(json = false): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async function gateway(action: "health" | "start-login" | "inspect" | "stop") {
    const headers = await authHeaders(true);
    if (!headers.Authorization) throw new Error("Sign in to Google Nexus first.");
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/notebooklm-browser-gateway`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `Gateway request failed (${res.status})`);
    return data;
  }

  async function checkService() {
    try {
      const data = await gateway("health");
      setState({ step: "ready", providers: data.providers });
    } catch (err) {
      setState({ step: "offline", message: String((err as Error)?.message ?? err) });
    }
  }

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
      void checkService();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runTool(tool: "health" | "start" | "inspect" | "stop") {
    setToolState({ kind: "running", tool });
    try {
      const action = tool === "start" ? "start-login" : tool;
      const data = await gateway(action);
      setToolState({ kind: "result", tool, data });
      if (tool === "health") setState({ step: "ready", providers: data.providers });
    } catch (err) {
      setToolState({ kind: "error", tool, message: String((err as Error)?.message ?? err) });
    }
  }

  const providers = state.step === "ready" ? state.providers : undefined;
  const liveUrl =
    toolState.kind === "result" && toolState.tool === "start" && typeof toolState.data === "object" && toolState.data !== null
      ? (toolState.data as { liveUrl?: string }).liveUrl
      : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-16">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">Google Nexus</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Connect NotebookLM</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          NotebookLM now uses a server-side browser gateway. Provider credentials stay in Supabase Edge Function secrets, while browser sessions stay isolated per signed-in user.
        </p>
      </div>

      {state.step === "checking" && <p className="text-sm text-muted-foreground">Checking browser gateway…</p>}

      {state.step === "offline" && (
        <div className="space-y-4 rounded-lg border border-border p-5">
          <div>
            <p className="text-sm font-medium text-foreground">Browser gateway is not ready</p>
            <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Configure the provider secret server-side, then check again. Never put provider tokens in VITE_* variables or browser code.
          </p>
          <Button type="button" onClick={() => void checkService()} disabled={!userId}>Check again</Button>
        </div>
      )}

      {state.step === "ready" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-5">
            <p className="text-sm font-medium text-foreground">Gateway online</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Browserless is the active HTTP automation path. Cloudflare, Steel, and Browserbase can remain configured as additional provider paths without exposing their credentials to the client.
            </p>
            {providers && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                {Object.entries(providers).map(([name, configured]) => (
                  <div key={name} className="rounded border border-border px-2 py-2">
                    <span className="font-medium text-foreground">{name}</span>: {configured ? "configured" : "not configured"}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-border p-4">
            <p className="text-xs font-medium text-muted-foreground">NotebookLM browser session</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => void runTool("start")} disabled={toolState.kind === "running"}>
                {toolState.kind === "running" && toolState.tool === "start" ? "Starting…" : "Open NotebookLM login"}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => void runTool("inspect")} disabled={toolState.kind === "running"}>
                {toolState.kind === "running" && toolState.tool === "inspect" ? "Inspecting…" : "Check session"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void runTool("stop")} disabled={toolState.kind === "running"}>
                Stop session
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => void runTool("health")} disabled={toolState.kind === "running"}>
                Refresh providers
              </Button>
            </div>

            {liveUrl && (
              <div className="rounded-md bg-muted p-3">
                <p className="text-xs text-muted-foreground">Interactive browser session is ready. Open it to complete Google/NotebookLM authentication.</p>
                <a className="mt-2 inline-block text-sm font-medium underline" href={liveUrl} target="_blank" rel="noreferrer">
                  Open remote NotebookLM browser
                </a>
              </div>
            )}

            {toolState.kind === "result" && (
              <pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(toolState.data, null, 2)}</pre>
            )}
            {toolState.kind === "error" && <p role="alert" className="text-xs text-destructive">{toolState.message}</p>}
          </div>
        </div>
      )}
    </main>
  );
}
