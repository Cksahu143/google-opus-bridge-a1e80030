import { logOperation } from "./audit.server";
import { getConnection, hasScopes } from "./connections.server";
import { missingScope, notConnected, NexusError } from "./errors";
import { createAdapterContext } from "./googleClient.server";
import { findCapability } from "./registry";
import type { AdapterContext } from "./types";

export type Actor = "web" | "mcp" | "workflow";

// Live "Claude is doing X right now" status, distinct from the
// after-the-fact operation_logs write below. Best-effort throughout: a
// failure to write activity_events must never break the actual
// capability call, so every call here is wrapped and swallows its own
// errors. Returns the row id (or null on failure) so the caller can mark
// it finished afterward.
async function startActivityEvent(params: {
  userId: string;
  capabilityId: string;
  service: string;
  title: string;
  actor: Actor;
}): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("activity_events")
      .insert({
        user_id: params.userId,
        capability_id: params.capabilityId,
        service: params.service,
        title: params.title,
        actor: params.actor,
        status: "running",
      })
      .select("id")
      .single();
    if (error) throw error;
    return data?.id ?? null;
  } catch (err) {
    console.error("Failed to write activity_events start row (non-fatal):", err);
    return null;
  }
}

async function finishActivityEvent(
  eventId: string | null,
  status: "done" | "error",
  detail?: string,
): Promise<void> {
  if (!eventId) return;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("activity_events")
      .update({ status, detail: detail ?? null, finished_at: new Date().toISOString() })
      .eq("id", eventId);
  } catch (err) {
    console.error("Failed to write activity_events finish row (non-fatal):", err);
  }
}

/**
 * The single entry point every surface (dashboard, MCP tools, workflows) uses to
 * run a capability. It resolves the adapter, validates input, enforces scopes
 * and writes the audit log. Google tokens never leave this layer.
 */
export async function runCapability(params: {
  userId: string;
  capabilityId: string;
  input: unknown;
  actor: Actor;
}): Promise<unknown> {
  const entry = findCapability(params.capabilityId);
  if (!entry) {
    throw new NexusError(
      "capability_not_found",
      `Unknown capability "${params.capabilityId}". Call list_capabilities for the catalog.`,
      404,
    );
  }
  const { adapter, capability } = entry;
  const parsed = capability.input.safeParse(params.input ?? {});
  if (!parsed.success) {
    throw new NexusError(
      "invalid_input",
      `Invalid input for ${capability.id}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
      400,
    );
  }

  const needsGoogle = adapter.requiresGoogleAuth !== false || capability.scopes.length > 0;
  let ctx: AdapterContext;
  const connection = await getConnection(params.userId);
  if (needsGoogle && (!connection || connection.status !== "connected")) throw notConnected();
  if (connection && !hasScopes(connection.granted_scopes ?? [], capability.scopes)) {
    throw missingScope(capability.scopes);
  }
  if (connection && connection.status === "connected") {
    // Even key-authenticated adapters (Imagen, Veo) need Drive to persist output.
    ctx = await createAdapterContext(params.userId);
  } else {
    ctx = {
      userId: params.userId,
      api: async () => {
        throw new NexusError("no_google_context", "This capability does not use Google OAuth.", 500);
      },
      raw: async () => {
        throw new NexusError("no_google_context", "This capability does not use Google OAuth.", 500);
      },
    };
  }

  const activityEventId = await startActivityEvent({
    userId: params.userId,
    capabilityId: capability.id,
    service: adapter.service,
    title: capability.title,
    actor: params.actor,
  });

  const startedAt = Date.now();
  try {
    const result = await capability.run(ctx, parsed.data as never);
    await finishActivityEvent(activityEventId, "done");
    await logOperation({
      userId: params.userId,
      service: adapter.service,
      capability: capability.id,
      implementation: capability.implementation,
      actor: params.actor,
      success: true,
      durationMs: Date.now() - startedAt,
      details: { input: parsed.data },
    });
    return result;
  } catch (error) {
    await finishActivityEvent(activityEventId, "error", (error as Error).message);
    await logOperation({
      userId: params.userId,
      service: adapter.service,
      capability: capability.id,
      implementation: capability.implementation,
      actor: params.actor,
      success: false,
      durationMs: Date.now() - startedAt,
      errorMessage: (error as Error).message,
      details: { input: parsed.data },
    });
    throw error;
  }
}
