/**
 * Browser-safe Supabase configuration for the linked project.
 *
 * Vercel builds receive the public values through Vite environment variables.
 * The linked-project fallback keeps the browser pointed at the same Supabase
 * project if a deployment was built without those public variables.
 *
 * Never add the service-role key or any other secret to this file.
 */

export const LINKED_SUPABASE_PROJECT_ID = "bjamfhlopmawtnzwwicu";
export const LINKED_SUPABASE_URL = `https://${LINKED_SUPABASE_PROJECT_ID}.supabase.co`;
export const LINKED_SUPABASE_PUBLISHABLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJqYW1maGxvcG1hd3Ruend3aWN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczODc1NDcsImV4cCI6MjEwMjk2MzU0N30.OkKBbz-LaNqbE3UzWhLlSkie6RRuI272ijz2qZ4U5XE";

type EnvLike = Record<string, string | boolean | undefined>;

function pick(env: EnvLike | undefined, keys: string[]): string | undefined {
  if (!env) return undefined;
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function viteEnv(): EnvLike | undefined {
  try {
    return import.meta.env as unknown as EnvLike;
  } catch {
    return undefined;
  }
}

function nodeEnv(): EnvLike | undefined {
  try {
    return typeof process !== "undefined" ? (process.env as EnvLike) : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeSupabaseUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(value);
}

export type SupabasePublicConfig = {
  url: string;
  publishableKey: string;
  projectId: string;
  source: "env" | "fallback";
};

/** Resolve public Supabase settings, preferring deployment environment values. */
export function getSupabasePublicConfig(): SupabasePublicConfig {
  const vite = viteEnv();
  const node = nodeEnv();

  const envUrl =
    pick(vite, ["VITE_SUPABASE_URL", "SUPABASE_URL"]) ??
    pick(node, ["SUPABASE_URL", "VITE_SUPABASE_URL"]);
  const envKey =
    pick(vite, [
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      "VITE_SUPABASE_ANON_KEY",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_ANON_KEY",
    ]) ??
    pick(node, [
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_ANON_KEY",
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      "VITE_SUPABASE_ANON_KEY",
    ]);

  const url = envUrl && looksLikeSupabaseUrl(envUrl) ? envUrl.replace(/\/+$/, "") : LINKED_SUPABASE_URL;
  const publishableKey = envKey ?? LINKED_SUPABASE_PUBLISHABLE_KEY;

  const envProjectId =
    pick(vite, ["VITE_SUPABASE_PROJECT_ID", "SUPABASE_PROJECT_ID"]) ??
    pick(node, ["SUPABASE_PROJECT_ID", "VITE_SUPABASE_PROJECT_ID"]);
  const projectId =
    envProjectId ??
    url.match(/^https?:\/\/([a-z0-9-]+)\.supabase\.(co|in|red)/i)?.[1] ??
    LINKED_SUPABASE_PROJECT_ID;

  const source: SupabasePublicConfig["source"] = envUrl && envKey ? "env" : "fallback";
  return { url, publishableKey, projectId, source };
}

/** Base URL for Supabase Edge Functions (`/functions/v1`) for the resolved project. */
export function getSupabaseFunctionsUrl(): string {
  const explicit = pick(viteEnv(), ["VITE_SUPABASE_FUNCTIONS_URL"]);
  if (explicit) return explicit.replace(/\/+$/, "");
  return `${getSupabasePublicConfig().url}/functions/v1`;
}
