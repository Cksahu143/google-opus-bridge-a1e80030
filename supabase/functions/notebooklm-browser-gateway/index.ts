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

async function requireUser(req: Request): Promise<Response | null> {
  if (!supabase) return json({ error: "Supabase server configuration is incomplete." }, 503);
  const authorization = req.headers.get("Authorization");
  const jwt = authorization?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return json({ error: "Invalid or expired session." }, 401);
  return null;
}

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
  const response = await steelRequest(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Steel session release failed (${response.status}).`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authError = await requireUser(req);
  if (authError) return authError;
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    if (action === "health") {
      return json({
        ok: true,
        providers: {
          cloudflare: Boolean(env("CLOUDFLARE_ACCOUNT_ID") && (env("CLOUDFLARE_API_TOKEN") || env("CLOUDFLARE_BROWSER_TOKEN"))),
          steel: Boolean(env("STEEL_API_KEY")),
          browserbase: Boolean(env("BROWSERBASE_API_KEY")),
          browserless: Boolean(env("BROWSERLESS_API_TOKEN")),
        },
      });
    }

    if (action === "create-session") {
      const provider = body?.provider || "steel";
      if (provider !== "steel") {
        return json({ error: `Provider ${provider} is not enabled for session creation yet.` }, 400);
      }
      const session = await createSteelSession();
      return json({ provider, session });
    }

    if (action === "release-session") {
      if (body?.provider !== "steel") return json({ error: "Only Steel sessions are supported for release." }, 400);
      await releaseSteelSession(String(body?.sessionId || ""));
      return json({ ok: true });
    }

    return json({ error: "Unsupported action.", supportedActions: ["health", "create-session", "release-session"] }, 400);
  } catch (error) {
    console.error("notebooklm-browser-gateway failed", error);
    return json({ error: String((error as Error)?.message ?? error) }, 502);
  }
});
