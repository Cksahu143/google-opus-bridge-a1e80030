import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;
const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...corsHeaders } });
const env = (name: string) => Deno.env.get(name)?.trim() || "";
type Provider = "browserless" | "browserbase" | "steel" | "cloudflare";

async function requireUser(req: Request) {
  if (!supabase) return { error: json({ error: "Supabase server configuration is incomplete." }, 503), userId: null };
  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return { error: json({ error: "Missing Authorization header." }, 401), userId: null };
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return { error: json({ error: "Invalid or expired session." }, 401), userId: null };
  return { error: null, userId: data.user.id };
}

function configuredProviders(): Record<Provider, boolean> {
  return {
    browserless: Boolean(env("BROWSERLESS_API_TOKEN") || env("BROWSERLESS_API_KEY") || env("BROWSERLESS_TOKEN")),
    browserbase: Boolean(env("BROWSERBASE_API_KEY")),
    steel: Boolean(env("STEEL_API_KEY")),
    cloudflare: Boolean(env("CLOUDFLARE_ACCOUNT_ID") && (env("CLOUDFLARE_API_TOKEN") || env("CLOUDFLARE_BROWSER_TOKEN"))),
  };
}
function token(name: string, ...aliases: string[]) { const value = [name, ...aliases].map(env).find(Boolean); if (!value) throw new Error(`${name} is not configured.`); return value; }

async function browserlessStart() {
  const origin = env("BROWSERLESS_BASE_URL") || "https://production-sfo.browserless.io";
  const apiToken = token("BROWSERLESS_API_TOKEN", "BROWSERLESS_API_KEY", "BROWSERLESS_TOKEN");
  const url = new URL("/session", origin); url.searchParams.set("token", apiToken);
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ttl: 120000, stealth: true, ...(env("BROWSERLESS_PROFILE") ? { profile: env("BROWSERLESS_PROFILE") } : {}) }) });
  const session = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Browserless session creation failed (${response.status}): ${session?.message || session?.error || "unknown error"}`);
  if (!session?.id || !session?.browserQL || !session?.stop) throw new Error("Browserless returned an incomplete session.");
  const bql = `mutation OpenNotebookLM { goto(url: "${NOTEBOOKLM_URL}", waitUntil: domContentLoaded) { status } liveURL(timeout: 120000, interactable: true, resizable: true, showBrowserInterface: false, emulateComponents: true) { liveURL } }`;
  const bqlResponse = await fetch(session.browserQL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: bql, variables: {}, operationName: "OpenNotebookLM" }) });
  const raw = await bqlResponse.text(); let data: any = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!bqlResponse.ok || data?.errors?.length) throw new Error(`Browserless BQL request failed (${bqlResponse.status}): ${data?.message || data?.errors?.[0]?.message || data?.raw || "unknown error"}`);
  return { provider: "browserless" as Provider, sessionId: session.id, expiresAt: new Date(Date.now() + Math.min(Number(session.ttl) || 120000, 120000)).toISOString(), liveUrl: data?.data?.liveURL?.liveURL || null, stopUrl: session.stop };
}

async function browserbaseStart() {
  const apiKey = token("BROWSERBASE_API_KEY");
  const response = await fetch("https://api.browserbase.com/v1/sessions", { method: "POST", headers: { "content-type": "application/json", "x-bb-api-key": apiKey }, body: JSON.stringify({ timeout: 600, keepAlive: true }) });
  const session = await response.json().catch(() => ({}));
  if (!response.ok || !session?.id || !session?.connectUrl) throw new Error(`Browserbase session creation failed (${response.status}): ${session?.message || session?.error || "unknown error"}`);
  const debugResponse = await fetch(`https://api.browserbase.com/v1/sessions/${session.id}/debug`, { headers: { "x-bb-api-key": apiKey } });
  const debug = await debugResponse.json().catch(() => ({}));
  if (!debugResponse.ok || !debug?.debuggerFullscreenUrl) throw new Error(`Browserbase live view creation failed (${debugResponse.status}).`);
  return { provider: "browserbase" as Provider, sessionId: session.id, expiresAt: session.expiresAt || new Date(Date.now() + 600000).toISOString(), liveUrl: debug.debuggerFullscreenUrl, stopUrl: `https://api.browserbase.com/v1/sessions/${session.id}` };
}

async function steelStart() {
  const apiKey = token("STEEL_API_KEY");
  const headers = { "steel-api-key": apiKey, "content-type": "application/json" };
  const response = await fetch("https://api.steel.dev/v1/sessions", { method: "POST", headers, body: JSON.stringify({ timeout: 600000, persistProfile: true }) });
  const session = await response.json().catch(() => ({}));
  if (!response.ok || !session?.id || !session?.debugUrl) throw new Error(`Steel session creation failed (${response.status}): ${session?.message || session?.error || "missing debugUrl"}`);
  const liveUrl = new URL(session.debugUrl);
  liveUrl.searchParams.set("interactive", "true");
  liveUrl.searchParams.set("showControls", "true");
  // Steel's current headful Live Session opens directly at the debug URL; the
  // session itself is created with a live page, so avoid the legacy CDP
  // navigation path here. The interactive viewer supports clicks and form input.
  return { provider: "steel" as Provider, sessionId: session.id, expiresAt: session.expiresAt || new Date(Date.now() + 600000).toISOString(), liveUrl: liveUrl.toString(), stopUrl: `https://api.steel.dev/v1/sessions/${session.id}/release` };
}

async function cloudflareStart() {
  const accountId = token("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = token("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_BROWSER_TOKEN");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser`;
  const createResponse = await fetch(`${base}?keep_alive=600000&targets=true&liveViewUrlExpiresInMs=600000`, { method: "POST", headers: { authorization: `Bearer ${apiToken}` } });
  const created = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok || !created?.result?.sessionId) throw new Error(`Cloudflare browser creation failed (${createResponse.status}): ${created?.errors?.[0]?.message || "unknown error"}`);
  const sessionId = created.result.sessionId;
  const targetResponse = await fetch(`${base}/${sessionId}/json/new?url=${encodeURIComponent(NOTEBOOKLM_URL)}`, { method: "PUT", headers: { authorization: `Bearer ${apiToken}` } });
  const target = await targetResponse.json().catch(() => ({}));
  if (!targetResponse.ok || !target?.devtoolsFrontendUrl) throw new Error(`Cloudflare target creation failed (${targetResponse.status}): ${target?.errors?.[0]?.message || "unknown error"}`);
  return { provider: "cloudflare" as Provider, sessionId, expiresAt: new Date(Date.now() + 600000).toISOString(), liveUrl: target.devtoolsFrontendUrl, stopUrl: `${base}/${sessionId}` };
}

async function persistSession(userId: string, session: { provider: Provider; sessionId: string; liveUrl: string | null; stopUrl: string; expiresAt: string }) {
  if (!supabase) throw new Error("Supabase server configuration is incomplete.");
  const { error } = await supabase.from("notebooklm_browser_sessions").upsert({ user_id: userId, provider: session.provider, provider_session_id: session.sessionId, browserql_url: session.liveUrl, stop_url: session.stopUrl, expires_at: session.expiresAt, updated_at: new Date().toISOString() }, { onConflict: "user_id,provider" });
  if (error) throw new Error(`Could not persist browser session: ${error.message}`);
}

async function stopProviderSession(session: any) {
  if (!session?.stop_url) return;
  try {
    if (session.provider === "browserbase") await fetch(session.stop_url, { method: "DELETE", headers: { "x-bb-api-key": token("BROWSERBASE_API_KEY") } });
    else if (session.provider === "steel") await fetch(session.stop_url, { method: "POST", headers: { "steel-api-key": token("STEEL_API_KEY"), "content-type": "application/json" } });
    else if (session.provider === "cloudflare") await fetch(session.stop_url, { method: "DELETE", headers: { authorization: `Bearer ${token("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_BROWSER_TOKEN")}` });
    else await fetch(`${session.stop_url}&force=true`, { method: "DELETE" });
  } catch { /* cleanup is best-effort */ }
}

async function stopAllUserSessions(userId: string) {
  if (!supabase) throw new Error("Supabase server configuration is incomplete.");
  const { data } = await supabase.from("notebooklm_browser_sessions").select("*").eq("user_id", userId);
  for (const session of data || []) await stopProviderSession(session);
  await supabase.from("notebooklm_browser_sessions").delete().eq("user_id", userId);
  return { ok: true, stopped: (data || []).length };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = await requireUser(req); if (auth.error) return auth.error;
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const body = await req.json().catch(() => ({})); const action = body?.action; const userId = auth.userId!;
    if (action === "health") return json({ ok: true, providers: configuredProviders() });
    if (action === "stop") return json(await stopAllUserSessions(userId));
    if (action === "start-login") {
      const requested = String(body?.provider || "auto") as Provider | "auto"; const available = configuredProviders();
      const order: Provider[] = requested === "auto" ? ["browserbase", "steel", "browserless", "cloudflare"] : [requested];
      const candidates = order.filter((p) => available[p]); if (!candidates.length) throw new Error(requested === "auto" ? "No browser provider is configured." : `${requested} is not configured.`);
      const errors: string[] = [];
      for (const provider of candidates) {
        try {
          const session = provider === "browserless" ? await browserlessStart() : provider === "browserbase" ? await browserbaseStart() : provider === "steel" ? await steelStart() : await cloudflareStart();
          await persistSession(userId, session); return json(session);
        } catch (error) { errors.push(`${provider}: ${String((error as Error)?.message ?? error)}`); }
      }
      throw new Error(`All selected browser providers failed. ${errors.join(" | ")}`);
    }
    return json({ error: "Unsupported action.", supportedActions: ["health", "start-login", "stop"] }, 400);
  } catch (error) { console.error("notebooklm-browser-gateway failed", error); return json({ error: String((error as Error)?.message ?? error) }, 502); }
});
