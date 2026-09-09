import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

async function admin(): Promise<SupabaseClient<Database>> {
  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );
  return supabaseAdmin;
}

export interface GoogleStoredTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
}

/**
 * Store Google OAuth credentials in Supabase Vault.
 *
 * The actual secret material is never stored in public.google_connections.
 * The Vault RPC performs the encrypted-at-rest persistence server-side.
 */
export async function storeGoogleTokens(params: {
  userId: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: string;
}): Promise<void> {
  const db = await admin();

  const { error } = await db.rpc("vault_upsert_google_tokens", {
    p_user_id: params.userId,
    p_access_token: params.accessToken,
    p_refresh_token: params.refreshToken ?? null,
    p_expires_at: params.expiresAt,
  });

  if (error) {
    throw error;
  }
}

/**
 * Read Google OAuth credentials from Supabase Vault.
 */
export async function readGoogleTokens(
  userId: string,
): Promise<GoogleStoredTokens | null> {
  const db = await admin();

  const { data, error } = await db.rpc("vault_read_google_tokens", {
    p_user_id: userId,
  });

  if (error) {
    throw error;
  }

  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return null;
  }

  const payload = data as Json;

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }

  if (typeof payload.access_token !== "string") {
    return null;
  }

  return {
    access_token: payload.access_token,
    refresh_token:
      typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : null,
    expires_at:
      typeof payload.expires_at === "string"
        ? payload.expires_at
        : null,
  };
}

/**
 * Check whether Google OAuth credentials exist in Supabase Vault.
 */
export async function hasGoogleTokens(userId: string): Promise<boolean> {
  const db = await admin();

  const { data, error } = await db.rpc("vault_has_google_tokens", {
    p_user_id: userId,
  });

  if (error) {
    throw error;
  }

  return data === true;
}

/**
 * Delete Google OAuth credentials from Supabase Vault.
 */
export async function deleteGoogleTokens(userId: string): Promise<void> {
  const db = await admin();

  const { error } = await db.rpc("vault_delete_google_tokens", {
    p_user_id: userId,
  });

  if (error) {
    throw error;
  }
}
