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
        content: "Connect Google Nexus to the real NotebookLM service running on your trusted machine.",
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
  | { step: "connected" };

type ToolState =
  | { kind: "idle" }
  | { kind: "running"; tool: "health" | "list" }
  | { kind: "result"; tool: "health" | "list"; data: unknown }
  | { kind: "error"; tool: "health" | "list"; message: string };

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

  async function checkService() {
    try {
      const headers = await authHeaders();
      if (!headers.Authorization) {
        setState({ step: "offline", message: "Sign in to Google Nexus first." });
        return;
      }

      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/notebooklm-proxy/health`, { headers });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setState({
          step: "offline",
          message:
            data.error ??
            "The NotebookLM service is not reachable. Start notebooklm-server on the trusted machine and check its secure network endpoint.",
        });
        return;
      }
      setState({ step: "connected" });
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

  async function runTool(tool: "health" | "list") {
    setToolState({ kind: "running", tool });
    try {
      const headers = await authHeaders();
      if (!headers.Authorization) throw new Error("You must be signed in.");

      const endpoint =
        tool === "health"
          ? `${SUPABASE_FUNCTIONS_URL}/notebooklm-proxy/health`
          : `${SUPABASE_FUNCTIONS_URL}/notebooklm-proxy/v1/notebooks`;
      const res = await fetch(endpoint, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `Request failed (${res.status})`);
      setToolState({ kind: "result", tool, data });
    } catch (err) {
      setToolState({ kind: "error", tool, message: String((err as Error)?.message ?? err) });
    }
  }

  const connected = state.step === "connected";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-16">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">Google Nexus</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Connect NotebookLM</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Nexus now talks to the real notebooklm-py service instead of trying to perform Google login inside Steel.
          Your Google session cookies remain on the machine running notebooklm-server.
        </p>
      </div>

      {state.step === "checking" && <p className="text-sm text-muted-foreground">Checking NotebookLM service…</p>}

      {state.step === "offline" && (
        <div className="space-y-4 rounded-lg border border-border p-5">
          <div>
            <p className="text-sm font-medium text-foreground">NotebookLM service is offline</p>
            <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          </div>
          <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">On the trusted machine</p>
            <p className="mt-1">Start notebooklm-server with NOTEBOOKLM_SERVER_TOKEN set, then expose it only through your secure private HTTPS/reverse-proxy path.</p>
            <p className="mt-2">If the Google session has expired, run <code>notebooklm login</code> there. Do not put Google passwords or storage_state.json into Nexus.</p>
          </div>
          <Button type="button" onClick={() => void checkService()} disabled={!userId}>Check again</Button>
        </div>
      )}

      {connected && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-5">
            <p className="text-sm font-medium text-foreground">NotebookLM service connected</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Requests are authenticated by Nexus and forwarded server-to-server. The browser never receives the NotebookLM service token.
            </p>
          </div>

          <div className="space-y-3 rounded-lg border border-border p-4">
            <p className="text-xs font-medium text-muted-foreground">Test the real NotebookLM service</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void runTool("health")}
                disabled={toolState.kind === "running"}
              >
                {toolState.kind === "running" && toolState.tool === "health" ? "Checking…" : "Check service"}
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
              <pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(toolState.data, null, 2)}</pre>
            )}
            {toolState.kind === "error" && <p role="alert" className="text-xs text-destructive">{toolState.message}</p>}
          </div>
        </div>
      )}
    </main>
  );
}
