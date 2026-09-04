import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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

async function steelRequest(path: string, init: RequestInit = {}) {
  const key = env("STEEL_API_KEY");
  if (!key) throw new Error("STEEL_API_KEY is not configured.");
  return fetch(`https://api.steel.dev${path}`, {
    ...init,
    headers: {
      "steel-api-key": key,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function browserlessRequest(path: string, init: RequestInit = {}) {
  const token = env("BROWSERLESS_API_TOKEN");
  const base = env("BROWSERLESS_BASE_URL") || "https://production-sfo.browserless.io";
  if (!token) throw new Error("BROWSERLESS_API_TOKEN is not configured.");
  const separator = path.includes("?") ? "&" : "?";
  return fetch(`${base}${path}${separator}token=${encodeURIComponent(token)}`, init);
}

async function browserbaseRequest(path: string, init: RequestInit = {}) {
  const key = env("BROWSERBASE_API_KEY");
  if (!key) throw new Error("BROWSERBASE_API_KEY is not configured.");
  return fetch(`https://api.browserbase.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function createSteelSession() {
  const profileId = env("STEEL_PROFILE_ID");
  const payload: Record<string, unknown> = {
    timeout: 600000,
    ...(profileId ? { profileId } : {}),
  };
  const response = await steelRequest("/v1/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Steel session creation failed (${response.status}).`);
  return response.json();
}

async function releaseSteelSession(sessionId: string) {
  if (!sessionId) return;
  const response = await steelRequest(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Steel session release failed (${response.status}).`);
  }
}

async function health() {
  const providers = {
    cloudflare: Boolean(env("CLOUDFLARE_ACCOUNT_ID") && env("CLOUDFLARE_API_TOKEN")),
    steel: Boolean(env("STEEL_API_KEY")),
    browserbase: Boolean(env("BROWSERBASE_API_KEY")),
    browserless: Boolean(env("BROWSERLESS_API_TOKEN")),
  };
  return json({ ok: true, providers });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    if (action === "health") return health();

    // Provider-neutral session creation. Steel is the first provider because its
    // Profiles API can persist cookies/local storage between sessions.
    if (action === "create-session") {
      const provider = body?.provider || "steel";
      if (provider === "steel") {
        const session = await createSteelSession();
        return json({ provider, session });
      }
      return json({ error: `Provider ${provider} is not enabled for session creation yet.` }, 400);
    }

    if (action === "release-session") {
      if (body?.provider !== "steel") return json({ error: "Only Steel sessions are supported for release." }, 400);
      await releaseSteelSession(String(body?.sessionId || ""));
      return json({ ok: true });
    }

    return json({
      error: "Unsupported action.",
      supportedActions: ["health", "create-session", "release-session"],
    }, 400);
  } catch (error) {
    console.error("notebooklm-browser-gateway failed", error);
    return json({ error: String((error as Error)?.message ?? error) }, 502);
  }
});
