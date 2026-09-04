import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });

const env = (name: string) => Deno.env.get(name)?.trim() || "";

async function requireUser(req: Request): Promise<{ error: Response | null; userId: string | null }> {
  if (!supabase) return { error: json({ error: "Supabase server configuration is incomplete." }, 503), userId: null };
  const authorization = req.headers.get("Authorization");
  const jwt = authorization?.replace(/^Bearer\s+/i, "");
  if (!jwt) return { error: json({ error: "Missing Authorization header." }, 401), userId: null };
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return { error: json({ error: "Invalid or expired session." }, 401), userId: null };
  return { error: null, userId: data.user.id };
}

function browserlessOrigin() {
  return env("BROWSERLESS_BASE_URL") || "https://production-sfo.browserless.io";
}

function browserlessToken() {
  const token = env("BROWSERLESS_API_TOKEN") || env("BROWSERLESS_API_KEY") || env("BROWSERLESS_TOKEN");
  if (!token) throw new Error("BROWSERLESS_API_TOKEN is not configured.");
  return token;
}

async function browserlessFetch(path: string, init: RequestInit = {}) {
  const token = browserlessToken();
  const url = new URL(path, browserlessOrigin());
  url.searchParams.set("token", token);
  return fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function createBrowserlessSession() {
  const configuredTtl = Number(env("BROWSERLESS_SESSION_TTL_MS"));
  const ttl = Number.isFinite(configuredTtl) && configuredTtl > 0
    ? Math.floor(configuredTtl)
    : 86_400_000;
  const profile = env("BROWSERLESS_PROFILE");
  const response = await browserlessFetch("/session", {
    method: "POST",
    body: JSON.stringify({
      ttl,
      stealth: true,
      ...(profile ? { profile } : {}),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data?.message === "string" ? data.message : typeof data?.error === "string" ? data.error : "";
    throw new Error(`Browserless session creation failed (${response.status})${detail ? `: ${detail}` : "."}`);
  }
  if (!data?.id || !data?.browserQL || !data?.stop) throw new Error("Browserless returned an incomplete session.");
  return data as { id: string; browserQL: string; stop: string; ttl: number };
}

async function runBrowserlessBql(browserQlUrl: string, query: string) {
  const response = await fetch(browserQlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: {}, operationName: query.match(/mutation\s+(\w+)/)?.[1] }),
  });
  const raw = await response.text();
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw: raw.slice(0, 2000) };
  }
  if (!response.ok) {
    const detail = typeof data?.message === "string"
      ? data.message
      : Array.isArray(data?.errors) && data.errors[0]?.message
        ? String(data.errors[0].message)
        : typeof data?.error === "string"
          ? data.error
          : typeof data?.raw === "string"
            ? data.raw
            : "";
    throw new Error(`Browserless BQL request failed (${response.status})${detail ? `: ${detail}` : "."}`);
  }
  if (data?.errors?.length) throw new Error(String(data.errors[0]?.message || "Browserless BQL error."));
  return data;
}

async function deleteBrowserlessSession(stopUrl: string) {
  const response = await fetch(`${stopUrl}&force=true`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Browserless session deletion failed (${response.status}).`);
  }
}

async function replaceUserSession(userId: string, session: { id: string; browserQL: string; stop: string; ttl: number }) {
  if (!supabase) throw new Error("Supabase server configuration is incomplete.");
  const { data: existing } = await supabase
    .from("notebooklm_browser_sessions")
    .select("id,stop_url")
    .eq("user_id", userId)
    .eq("provider", "browserless")
    .maybeSingle();

  if (existing?.stop_url) {
    await fetch(`${existing.stop_url}&force=true`, { method: "DELETE" }).catch(() => undefined);
  }

  const expiresAt = new Date(Date.now() + session.ttl).toISOString();
  const { error } = await supabase.from("notebooklm_browser_sessions").upsert({
    id: existing?.id,
    user_id: userId,
    provider: "browserless",
    provider_session_id: session.id,
    browserql_url: session.browserQL,
    stop_url: session.stop,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  if (error) throw new Error(`Could not persist browser session: ${error.message}`);
}

async function getUserSession(userId: string) {
  if (!supabase) throw new Error("Supabase server configuration is incomplete.");
  const { data, error } = await supabase
    .from("notebooklm_browser_sessions")
    .select("id,provider_session_id,browserql_url,stop_url,expires_at")
    .eq("user_id", userId)
    .eq("provider", "browserless")
    .maybeSingle();
  if (error) throw new Error(`Could not read browser session: ${error.message}`);
  if (!data?.browserql_url || !data?.stop_url) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    await supabase.from("notebooklm_browser_sessions").delete().eq("id", data.id);
    return null;
  }
  return data;
}

async function startLogin(userId: string) {
  const session = await createBrowserlessSession();
  try {
    await replaceUserSession(userId, session);
    const result = await runBrowserlessBql(session.browserQL, `
      mutation OpenNotebookLM {
        goto(url: "https://notebooklm.google.com/", waitUntil: domContentLoaded) { status }
        liveURL(timeout: 120000, interactable: true, resizable: true, showBrowserInterface: false) { liveURL }
      }
    `);
    return {
      provider: "browserless",
      sessionId: session.id,
      expiresAt: new Date(Date.now() + session.ttl).toISOString(),
      liveUrl: result?.data?.liveURL?.liveURL ?? null,
    };
  } catch (error) {
    await deleteBrowserlessSession(session.stop).catch(() => undefined);
    if (supabase) {
      await supabase
        .from("notebooklm_browser_sessions")
        .delete()
        .eq("user_id", userId)
        .eq("provider", "browserless");
    }
    throw error;
  }
}

async function inspectNotebookLm(userId: string) {
  const session = await getUserSession(userId);
  if (!session) throw new Error("No active Browserless NotebookLM session. Start the login session first.");
  const result = await runBrowserlessBql(session.browserql_url, `
    mutation InspectNotebookLM {
      html { html }
    }
  `);
  const html = String(result?.data?.html?.html ?? "");
  return {
    provider: "browserless",
    sessionId: session.provider_session_id,
    htmlLength: html.length,
    textPreview: html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000),
  };
}

async function stopUserSession(userId: string) {
  const session = await getUserSession(userId);
  if (!session) return { ok: true, stopped: false };
  await deleteBrowserlessSession(session.stop_url);
  if (supabase) await supabase.from("notebooklm_browser_sessions").delete().eq("id", session.id);
  return { ok: true, stopped: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action;
    const userId = auth.userId!;

    if (action === "health") {
      return json({
        ok: true,
        providers: {
          cloudflare: Boolean(env("CLOUDFLARE_ACCOUNT_ID") && (env("CLOUDFLARE_API_TOKEN") || env("CLOUDFLARE_BROWSER_TOKEN"))),
          steel: Boolean(env("STEEL_API_KEY")),
          browserbase: Boolean(env("BROWSERBASE_API_KEY")),
          browserless: Boolean(env("BROWSERLESS_API_TOKEN") || env("BROWSERLESS_API_KEY") || env("BROWSERLESS_TOKEN")),
        },
      });
    }

    if (action === "start-login") return json(await startLogin(userId));
    if (action === "inspect") return json(await inspectNotebookLm(userId));
    if (action === "stop") return json(await stopUserSession(userId));

    return json({ error: "Unsupported action.", supportedActions: ["health", "start-login", "inspect", "stop"] }, 400);
  } catch (error) {
    console.error("notebooklm-browser-gateway failed", error);
    return json({ error: String((error as Error)?.message ?? error) }, 502);
  }
});
