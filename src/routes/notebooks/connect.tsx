import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/notebooks/connect")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Connect NotebookLM · Google Nexus" },
      { name: "description", content: "Connect Google Nexus to NotebookLM through a selectable server-side browser gateway." },
    ],
  }),
  component: ConnectNotebookLmPage,
});

const SUPABASE_FUNCTIONS_URL =
  (import.meta.env["VITE_SUPABASE_FUNCTIONS_URL"] as string | undefined) ??
  `${(import.meta.env["VITE_SUPABASE_URL"] as string | undefined) ?? ""}/functions/v1`;

type Provider = "auto" | "browserless" | "browserbase" | "steel" | "cloudflare";
type State =
  | { step: "checking" }
  | { step: "offline"; message?: string }
  | { step: "ready"; providers?: Record<string, boolean> };
type ToolState =
  | { kind: "idle" }
  | { kind: "running"; tool: "health" | "start" | "stop" }
  | { kind: "result"; tool: "health" | "start" | "stop"; data: unknown }
  | { kind: "error"; tool: "health" | "start" | "stop"; message: string };

const PROVIDER_LABELS: Record<Exclude<Provider, "auto">, string> = {
  browserbase: "Browserbase",
  steel: "Steel",
  browserless: "Browserless",
  cloudflare: "Cloudflare",
};

function ConnectNotebookLmPage() {
  const [state, setState] = useState<State>({ step: "checking" });
  const [userId, setUserId] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>("auto");
  const [toolState, setToolState] = useState<ToolState>({ kind: "idle" });

  async function authHeaders(json = false): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return { ...(json ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  async function gateway(action: "health" | "start-login" | "stop", selectedProvider?: Provider) {
    const headers = await authHeaders(true);
    if (!headers.Authorization) throw new Error("Sign in to Google Nexus first.");
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/notebooklm-browser-gateway`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...(selectedProvider ? { provider: selectedProvider } : {}) }),
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

  async function runTool(tool: "health" | "start" | "stop") {
    setToolState({ kind: "running", tool });
    try {
      const data = await gateway(tool === "start" ? "start-login" : tool, tool === "start" ? provider : undefined);
      setToolState({ kind: "result", tool, data });
      if (tool === "health") setState({ step: "ready", providers: data.providers });
    } catch (err) {
      setToolState({ kind: "error", tool, message: String((err as Error)?.message ?? err) });
    }
  }

  const providers = state.step === "ready" ? state.providers : undefined;
  const resultData = toolState.kind === "result" && typeof toolState.data === "object" && toolState.data !== null ? toolState.data as Record<string, unknown> : undefined;
  const liveUrl = typeof resultData?.liveUrl === "string" ? resultData.liveUrl : undefined;
  const activeProvider = typeof resultData?.provider === "string" ? resultData.provider : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-16">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">Google Nexus</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Connect NotebookLM</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose the cloud browser provider for the NotebookLM login session. Credentials remain server-side in Supabase Edge Function secrets.
        </p>
      </div>

      {state.step === "checking" && <p className="text-sm text-muted-foreground">Checking browser providers…</p>}

      {state.step === "offline" && (
        <div className="space-y-4 rounded-lg border border-border p-5">
          <div>
            <p className="text-sm font-medium text-foreground">Browser gateway is not ready</p>
            <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          </div>
          <p className="text-xs text-muted-foreground">Configure at least one provider secret server-side, then check again. Never put provider tokens in VITE_* variables or browser code.</p>
          <Button type="button" onClick={() => void checkService()} disabled={!userId}>Check again</Button>
        </div>
      )}

      {state.step === "ready" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-5">
            <p className="text-sm font-medium text-foreground">Browser gateway online</p>
            <p className="mt-1 text-sm text-muted-foreground">Pick a provider, or use Auto to try the best configured path first and fall back if it fails.</p>
            {providers && (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(Object.keys(PROVIDER_LABELS) as Array<Exclude<Provider, "auto">>).map((name) => (
                  <div key={name} className="rounded border border-border px-2 py-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{PROVIDER_LABELS[name]}</span>: {providers[name] ? "ready" : "not configured"}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-4 rounded-lg border border-border p-4">
            <div className="space-y-2">
              <label htmlFor="browser-provider" className="text-xs font-medium text-muted-foreground">Browser provider</label>
              <select id="browser-provider" value={provider} onChange={(event) => setProvider(event.target.value as Provider)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                <option value="auto">Auto — use configured fallback order</option>
                {(Object.keys(PROVIDER_LABELS) as Array<Exclude<Provider, "auto">>).map((name) => (
                  <option key={name} value={name}>{PROVIDER_LABELS[name]}{providers?.[name] ? " — configured" : " — unavailable"}</option>
                ))}
              </select>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground">NotebookLM browser session</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => void runTool("start")} disabled={toolState.kind === "running" || (provider !== "auto" && !providers?.[provider])}>
                  {toolState.kind === "running" && toolState.tool === "start" ? "Starting…" : "Open NotebookLM login"}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void runTool("stop")} disabled={toolState.kind === "running"}>Stop all sessions</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void runTool("health")} disabled={toolState.kind === "running"}>Refresh providers</Button>
              </div>
            </div>

            {liveUrl && (
              <div className="rounded-md bg-muted p-3">
                <p className="text-xs text-muted-foreground">{activeProvider ? `${PROVIDER_LABELS[activeProvider as Exclude<Provider, "auto">] ?? activeProvider} session is ready.` : "Interactive browser session is ready."} Open it to complete Google/NotebookLM authentication.</p>
                <a className="mt-2 inline-block text-sm font-medium underline" href={liveUrl} target="_blank" rel="noreferrer">Open remote NotebookLM browser</a>
              </div>
            )}

            {toolState.kind === "result" && <pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(toolState.data, null, 2)}</pre>}
            {toolState.kind === "error" && <p role="alert" className="text-xs text-destructive">{toolState.message}</p>}
          </div>
        </div>
      )}
    </main>
  );
}
