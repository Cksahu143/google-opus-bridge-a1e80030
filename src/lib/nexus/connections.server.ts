import {
  deleteGoogleTokens,
  hasGoogleTokens,
  readGoogleTokens,
  storeGoogleTokens,
} from "./crypto.server";
import { notConnected } from "./errors";
import { refreshAccessToken, revokeToken } from "./oauth.server";

export interface StoredConnection {
  user_id: string;
  google_email: string | null;
  google_sub: string | null;
  access_token_expires_at: string | null;
  granted_scopes: string[];
  status: string;
  last_error: string | null;
  updated_at: string;
}

export type GoogleConnectionSaveStage =
  | "vault_storage"
  | "metadata_persistence";

export class GoogleConnectionSaveError extends Error {
  readonly stage: GoogleConnectionSaveStage;

  constructor(stage: GoogleConnectionSaveStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Unexpected persistence error.");
    this.name = "GoogleConnectionSaveError";
    this.stage = stage;
  }
}

async function admin() {
  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );

  return supabaseAdmin;
}

export async function getConnection(
  userId: string,
): Promise<StoredConnection | null> {
  const db = await admin();

  const { data, error } = await db
    .from("google_connections")
    .select(
      "user_id, google_email, google_sub, access_token_expires_at, granted_scopes, status, last_error, updated_at",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const connection = data as StoredConnection;

  /*
   * Metadata can say "connected" while the Vault secret is missing.
   * Detect that state and force re-authentication rather than pretending
   * the connection is usable.
   */
  if (connection.status === "connected") {
    try {
      const credentialsExist = await hasGoogleTokens(userId);

      if (!credentialsExist) {
        return {
          ...connection,
          status: "needs_reauth",
          last_error:
            "Google credentials are missing; reconnect Google.",
        };
      }
    } catch {
      return {
        ...connection,
        status: "needs_reauth",
        last_error:
          "Google credentials could not be verified; reconnect Google.",
      };
    }
  }

  return connection;
}

export async function saveConnection(params: {
  userId: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresInSeconds: number;
  scopes: string[];
  googleEmail?: string | undefined;
  googleSub?: string | undefined;
}) {
  const db = await admin();

  let existing: StoredConnection | null;
  try {
    existing = await getConnection(params.userId);
  } catch (error) {
    throw new GoogleConnectionSaveError("metadata_persistence", error);
  }

  const expiresAt = new Date(
    Date.now() + params.expiresInSeconds * 1000,
  ).toISOString();

  /*
   * First save only non-secret connection metadata.
   *
   * The OAuth tokens themselves are stored separately in Supabase Vault.
   */
  const { error: metadataError } = await db
    .from("google_connections")
    .upsert(
      {
        user_id: params.userId,
        google_email:
          params.googleEmail ?? existing?.google_email ?? null,
        google_sub:
          params.googleSub ?? existing?.google_sub ?? null,
        access_token_expires_at: expiresAt,
        granted_scopes: params.scopes,
        status: "pending",
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "user_id",
      },
    );

  if (metadataError) {
    throw new GoogleConnectionSaveError("metadata_persistence", metadataError);
  }

  /*
   * Store the actual credentials in Supabase Vault.
   *
   * Passing null for refresh_token tells the Vault RPC to preserve an
   * existing refresh token when appropriate.
   */
  try {
    await storeGoogleTokens({
      userId: params.userId,
      accessToken: params.accessToken,
      refreshToken: params.refreshToken ?? null,
      expiresAt,
    });
  } catch (error) {
    await db
      .from("google_connections")
      .update({
        status: "needs_reauth",
        last_error:
          error instanceof Error
            ? error.message
            : "Failed to store Google credentials.",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", params.userId);

    throw new GoogleConnectionSaveError("vault_storage", error);
  }

  /*
   * Only report the connection as connected after the Vault write succeeds.
   */
  const { error: connectedError } = await db
    .from("google_connections")
    .update({
      status: "connected",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", params.userId);

  if (connectedError) {
    throw new GoogleConnectionSaveError("metadata_persistence", connectedError);
  }
}

export async function markConnectionError(
  userId: string,
  message: string,
) {
  const db = await admin();

  await db
    .from("google_connections")
    .update({
      status: "needs_reauth",
      last_error: message,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
}

/**
 * Returns a valid Google access token.
 *
 * Reads credentials from Vault and refreshes the access token when it
 * has less than 60 seconds remaining.
 */
export async function getAccessToken(
  userId: string,
): Promise<string> {
  const connection = await getConnection(userId);

  if (!connection || connection.status !== "connected") {
    throw notConnected();
  }

  const tokens = await readGoogleTokens(userId);

  if (!tokens) {
    await markConnectionError(
      userId,
      "Google credentials are missing; reconnect Google.",
    );

    throw notConnected();
  }

  const expiresAt = connection.access_token_expires_at
    ? Date.parse(connection.access_token_expires_at)
    : 0;

  const stillFresh = expiresAt - Date.now() > 60_000;

  if (stillFresh) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    await markConnectionError(
      userId,
      "No refresh token stored; reconnect Google.",
    );

    throw notConnected();
  }

  try {
    const refreshed = await refreshAccessToken(
      tokens.refresh_token,
    );

    await saveConnection({
      userId,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? null,
      expiresInSeconds: refreshed.expires_in,
      scopes: refreshed.scope
        ? refreshed.scope.split(" ")
        : connection.granted_scopes,
      googleEmail: connection.google_email ?? undefined,
      googleSub: connection.google_sub ?? undefined,
    });

    return refreshed.access_token;
  } catch (error) {
    await markConnectionError(
      userId,
      error instanceof Error
        ? error.message
        : "Google token refresh failed.",
    );

    throw error;
  }
}

export async function disconnect(userId: string) {
  /*
   * Try to revoke the Google grant before deleting the local credentials.
   */
  const tokens = await readGoogleTokens(userId).catch(() => null);

  if (tokens?.refresh_token) {
    await revokeToken(tokens.refresh_token).catch(() => undefined);
  }

  const db = await admin();

  /*
   * Delete the actual OAuth credentials from Vault.
   */
  await deleteGoogleTokens(userId).catch(() => undefined);

  /*
   * Delete only non-secret connection metadata from the public table.
   */
  await db
    .from("google_connections")
    .delete()
    .eq("user_id", userId);

  await db
    .from("service_health")
    .delete()
    .eq("user_id", userId);
}

export function hasScopes(
  granted: string[],
  required: string[],
): boolean {
  if (required.length === 0) {
    return true;
  }

  const set = new Set(granted);

  // `drive` implies drive.readonly/file for our purposes.
  return required.every(
    (scope) =>
      set.has(scope) ||
      (scope.startsWith(
        "https://www.googleapis.com/auth/drive",
      ) &&
        set.has(
          "https://www.googleapis.com/auth/drive",
        )),
  );
}
