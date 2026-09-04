import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/notebooks/connect")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Connect NotebookLM · Google Nexus" },
      { name: "description", content: "Connect Google Nexus to NotebookLM with an iPad-first, security-aware flow." },
    ],
  }),
  component: ConnectNotebookLmPage,
});

const SUPABASE_FUNCTIONS_URL =
  (import.meta.env["VITE_SUPABASE_FUNCTIONS_URL"] as string | undefined) ??
  `${(import.meta.env["VITE_SUPABASE_URL"] as string | undefined) ?? ""}/functions/v1`;
const NOTEBOOKLM_URL = "https://notebooklm.google.com/";

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

type BridgeHealth = {
  ok?: boolean;
  configured?: boolean;
  authMode?: string;
  officialLoginDoesNotTransferSession?: boolean;
};

const PROVIDER_LABELS: Record<Exclude<Provider, "auto">, string> = {
  browserbase: "Browserbase",
  steel: "Steel",
  browserless: "Browserless",
  cloudflare: "Cloudflare",
};

function ConnectNotebookLmPage() {
  const [state, setState] = useState<State>({ step: "checking" });
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>("auto");
  const [toolState, setToolState] = useState<ToolState>({ kind: "idle" });

  async function authHeaders(json = false): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return { ...(json ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  async function notebooklmHealth(): Promise<BridgeHealth> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new Error("Sign in to Google Nexus first.");
    const response = await fetch("/api/notebooklm?action=health", { headers });
    const data = (await response.json().catch(() => ({}))) as BridgeHealth & { error?: string };
    if (!response.ok || data.ok !== true) throw new Error(data.error || "NotebookLM bridge health check failed.");
    return data;
  }

  async function checkService() {
    try {
      const [gateway, notebooklm] = await Promise.all([
        gatewayCall("health"),
        notebooklmHealth(),
      ]);
      setBridgeHealth(notebooklm);
      setState({ step: "ready", providers: gateway.providers });
    } catch (err) {
      setState({ step: "offline", message: String((err as Error)?.message ?? err) });
    }
  }

  async function gatewayCall(action: "health" | "start-login" | "stop", selectedProvider?: Provider) {
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
      const data = await gatewayCall(tool === "start" ? "start-login" : tool, tool === "start" ? provider : undefined);
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
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10 md:py-16">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">Google Nexus</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Connect NotebookLM</h1>
        <p className="mt-2 text-sm text-muted-foreground">iPad-first connection manager. No Mac, Terminal, VM, or credential copying is required by this screen.</p>
      </div>

      {state.step === "checking" && <p className="text-sm text-muted-foreground">Checking NotebookLM and browser-gateway status…</p>}

      {state.step === "offline" && (
        <div className="space-y-4 rounded-lg border border-border p-5">
          <div>
            <p className="text-sm font-medium text-foreground">Connection check could not complete</p>
            <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          </div>
          <Button type="button" onClick={() => void checkService()} disabled={!userId}>Check again</Button>
        </div>
      )}

      {state.step === "ready" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-5">
            <p className="text-sm font-medium text-foreground">1. Sign in normally</p>
            <p className="mt-1 text-sm text-muted-foreground">Open the official NotebookLM site in a normal top-level iPad browser and sign in there. Google authentication stays between you and Google.</p>
            <Button type="button" className="mt-4" onClick={() => window.open(NOTEBOOKLM_URL, "_blank", "noopener,noreferrer")}>Open official NotebookLM</Button>
          </div>

          <div className="rounded-lg border border-border p-5">
            <p className="text-sm font-medium text-foreground">2. Bridge authentication status</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {bridgeHealth?.configured
                ? "The server-side NotebookLM integration is configured. Its credential stays on the server and is never returned to the iPad."
                : "The server-side NotebookLM integration is not configured yet. Signing into the official site does not automatically transfer Google cookies or tokens into the Bridge."}
            </p>
            <div className="mt-3 rounded-md bg-muted p-3 text-xs">
              <p><span className="font-medium">Bridge:</span> {bridgeHealth?.configured ? "configured" : "not configured"}</p>
              <p className="mt-1"><span className="font-medium">Auth mode:</span> {bridgeHealth?.authMode || "unknown"}</p>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">We intentionally do not extract Google session cookies, bearer tokens, or other account credentials from the browser.</p>
          </div>

          <div className="rounded-lg border border-border p-5">
            <p className="text-sm font-medium text-foreground">3. Browser providers are separate</p>
            <p className="mt-1 text-sm text-muted-foreground">Remote browser sessions can be used for testing, but they are not presented as a way to bypass Google's authentication protections.</p>
            {providers && (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(Object.keys(PROVIDER_LABELS) as Array<Exclude<Provider, "auto">>).map((name) => (
                  <div key={name} className="rounded border border-border px-2 py-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{PROVIDER_LABELS[name]}</span>: {providers[name] ? "ready" : "not configured"}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 space-y-3">
              <label htmlFor="browser-provider" className="text-xs font-medium text-muted-foreground">Provider</label>
              <select id="browser-provider" value={provider} onChange={(event) => setProvider(event.target.value as Provider)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                <option value="auto">Auto — configured fallback order</option>
                {(Object.keys(PROVIDER_LABELS) as Array<Exclude<Provider, "auto">>).map((name) => (
                  <option key={name} value={name}>{PROVIDER_LABELS[name]}{providers?.[name] ? " — configured" : " — unavailable"}</option>
                ))}
              </select>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => void runTool("start")} disabled={toolState.kind === "running" || (provider !== "auto" && !providers?.[provider])}>
                  {toolState.kind === "running" && toolState.tool === "start" ? "Starting…" : "Open remote browser test"}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void runTool("stop")} disabled={toolState.kind === "running"}>Stop sessions</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void checkService()} disabled={toolState.kind === "running"}>Refresh status</Button>
              </div>
            </div>
            {liveUrl && (
              <div className="mt-4 rounded-md bg-muted p-3">
                <p className="text-xs text-muted-foreground">{activeProvider ? `${PROVIDER_LABELS[activeProvider as Exclude<Provider, "auto">] ?? activeProvider} session is ready.` : "Remote browser session is ready."} This is a test session.</p>
                <a className="mt-2 inline-block text-sm font-medium underline" href={liveUrl} target="_blank" rel="noreferrer">Open remote browser</a>
              </div>
            )}
            {toolState.kind === "result" && <pre className="mt-3 max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(toolState.data, null, 2)}</pre>}
            {toolState.kind === "error" && <p role="alert" className="mt-3 text-xs text-destructive">{toolState.message}</p>}
          </div>
        </div>
      )}
    </main>
  );
}
