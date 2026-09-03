// Supabase Edge Function: authenticated bridge to the user's local notebooklm-py REST service.
// The NotebookLM Google session never leaves the machine running notebooklm-server.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const NOTEBOOKLM_BASE_URL = Deno.env.get("NOTEBOOKLM_BASE_URL");
const NOTEBOOKLM_SERVER_TOKEN = Deno.env.get("NOTEBOOKLM_SERVER_TOKEN");

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

async function requireUser(req: Request): Promise<Response | null> {
  if (!supabase) return json({ error: "Supabase server configuration is incomplete." }, 503);

  const header = req.headers.get("Authorization");
  const jwt = header?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header" }, 401);

  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return json({ error: "Invalid or expired session" }, 401);
  return null;
}

function serviceUrl(path: string): string {
  if (!NOTEBOOKLM_BASE_URL) throw new Error("NOTEBOOKLM_BASE_URL is not configured.");
  const base = NOTEBOOKLM_BASE_URL.replace(/\/$/, "");
  return `${base}${path}`;
}

function serviceHeaders(contentType?: string): Record<string, string> {
  if (!NOTEBOOKLM_SERVER_TOKEN) throw new Error("NOTEBOOKLM_SERVER_TOKEN is not configured.");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${NOTEBOOKLM_SERVER_TOKEN}`,
  };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

function allowedPath(path: string): boolean {
  // Deliberately narrow: the web app gets NotebookLM notebook/source/chat
  // operations, but cannot turn this function into a general HTTP proxy.
  return (
    path === "/v1/notebooks" ||
    /^\/v1\/notebooks\/[^/]+$/.test(path) ||
    /^\/v1\/notebooks\/[^/]+\/suggested-prompts$/.test(path) ||
    /^\/v1\/notebooks\/[^/]+\/chat$/.test(path) ||
    /^\/v1\/notebooks\/[^/]+\/chat\/configure$/.test(path) ||
    /^\/v1\/notebooks\/[^/]+\/sources\/(url|text|batch)$/.test(path) ||
    /^\/v1\/notebooks\/[^/]+\/sources\/[^/]+$/.test(path) ||
    /^\/v1\/notebooks\/[^/]+\/sources\/[^/]+\/content$/.test(path)
  );
}

function allowedMethod(path: string, method: string): boolean {
  if (path === "/v1/notebooks") return ["GET", "POST"].includes(method);
  if (/\/suggested-prompts$/.test(path)) return method === "GET";
  if (/\/chat$/.test(path) || /\/chat\/configure$/.test(path)) return method === "POST";
  if (/\/sources\/(url|text|batch)$/.test(path)) return method === "POST";
  if (/\/sources\/[^/]+\/content$/.test(path)) return method === "GET";
  if (/\/sources\/[^/]+$/.test(path)) return ["PATCH", "DELETE"].includes(method);
  return ["GET", "PATCH", "DELETE"].includes(method);
}

async function proxy(req: Request, path: string): Promise<Response> {
  if (!NOTEBOOKLM_BASE_URL || !NOTEBOOKLM_SERVER_TOKEN) {
    return json(
      {
        error:
          "NotebookLM service is not configured. Set NOTEBOOKLM_BASE_URL and NOTEBOOKLM_SERVER_TOKEN on the Edge Function.",
      },
      503,
    );
  }

  if (!allowedPath(path)) return json({ error: "NotebookLM operation is not allowed." }, 404);
  if (!allowedMethod(path, req.method)) return json({ error: "Method not allowed." }, 405);

  const contentType = req.headers.get("content-type") ?? undefined;
  const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.arrayBuffer();

  const upstream = await fetch(serviceUrl(path), {
    method: req.method,
    headers: serviceHeaders(contentType),
    body,
  });

  const responseType = upstream.headers.get("content-type") ?? "application/json";
  const responseBody = await upstream.arrayBuffer();
  return new Response(responseBody, {
    status: upstream.status,
    headers: { "content-type": responseType, ...corsHeaders },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authError = await requireUser(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/notebooklm-proxy/, "") || "/";

  // This is an authenticated app health check. The upstream /healthz itself
  // intentionally has no bearer requirement, but we still require a signed-in
  // Bridge user before revealing service status to the browser.
  if (req.method === "GET" && path === "/health") {
    if (!NOTEBOOKLM_BASE_URL) return json({ ok: false, configured: false }, 503);
    try {
      const upstream = await fetch(serviceUrl("/healthz"), { signal: AbortSignal.timeout(5000) });
      const data = await upstream.json().catch(() => ({ ok: false }));
      return json({ ok: upstream.ok && data?.ok === true, configured: true }, upstream.ok ? 200 : 503);
    } catch (err) {
      return json({ ok: false, configured: true, error: String((err as Error)?.message ?? err) }, 503);
    }
  }

  try {
    return await proxy(req, path);
  } catch (err) {
    console.error("notebooklm-proxy failed:", err);
    return json({ error: String((err as Error)?.message ?? err) }, 502);
  }
});
