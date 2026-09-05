import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getSupabasePublicConfig } from "@/integrations/supabase/publicConfig";
import { capabilityCatalog, findCapability, ADAPTERS } from "@/lib/nexus/registry";
import { nexusStatus } from "@/lib/nexus/dashboard.server";
import { runCapability } from "@/lib/nexus/router.server";

const PRODUCTION_ORIGIN = "https://google-opus-bridge-a1e80030.vercel.app";
const RESOURCE_URL = `${PRODUCTION_ORIGIN}/mcp`;

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

async function authenticateRequest(request: Request): Promise<string> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${PRODUCTION_ORIGIN}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  const { url, publishableKey } = getSupabasePublicConfig();
  const supabase = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase.auth.getUser(match[1]);
  if (error || !data.user) {
    throw new Response("Invalid access token", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${PRODUCTION_ORIGIN}/.well-known/oauth-protected-resource"`,
      },
    });
  }
  return data.user.id;
}

export async function createMcpHandler(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await authenticateRequest(request);
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Authentication failed", { status: 401 });
  }

  const server = new McpServer(
    { name: "google-nexus-gateway", version: "1.3.0" },
    {
      instructions:
        "Google Nexus is one connection to the whole Google ecosystem and configured Google Cloud services for the signed-in user. Start with search_capabilities when you know the task but not the exact capability id, or list_capabilities for the complete catalog. Use call_capability for one operation and batch_call_capabilities for a short ordered workflow. Use connection_status when a call reports a missing connection or permission.",
    },
  );

  server.registerTool(
    "list_capabilities",
    {
      title: "List Google capabilities",
      description:
        "List every Google capability Google Nexus exposes (Gmail, Drive, Docs, Sheets, Slides, Calendar, Tasks, Contacts, Meet, Chat, Forms, Apps Script, Gemini, image/video/music generation, Flow projects, grounded notebooks). Call this first to discover capability ids and their input fields.",
      inputSchema: {
        service: z.string().optional().describe("Optional service filter, e.g. gmail, drive, calendar, video."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ service }) => {
      const visibleAdapters = ADAPTERS.filter((adapter) => !adapter.hidden);
      const visibleServices = new Set(visibleAdapters.map((adapter) => adapter.service));
      const capabilities = capabilityCatalog().filter(
        (entry) => visibleServices.has(entry.service) && (!service || entry.service === service),
      );
      return textResult({
        services: visibleAdapters.map((adapter) => ({
          service: adapter.service,
          label: adapter.label,
          status: adapter.status,
          note: adapter.statusNote,
        })),
        capabilities,
      });
    },
  );

  server.registerTool(
    "search_capabilities",
    {
      title: "Search Google capabilities",
      description:
        "Find Google Nexus capabilities by service, name, description, or implementation. Use this before call_capability when you know what you want to do but not the exact capability id.",
      inputSchema: {
        query: z.string().trim().optional().describe("Text to match against capability id, service, title, or description."),
        service: z.string().trim().optional().describe("Optional service filter such as drive, gmail, calendar, tasks, or github."),
        mutating: z.boolean().optional().describe("If set, return only read-only or mutating capabilities."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of matches."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, service, mutating, limit }) => {
      const needle = query?.toLowerCase();
      const serviceNeedle = service?.toLowerCase();
      const matches = capabilityCatalog()
        .filter((item) => !serviceNeedle || item.service.toLowerCase() === serviceNeedle)
        .filter((item) => mutating === undefined || item.mutating === mutating)
        .filter((item) => {
          if (!needle) return true;
          return [item.id, item.service, item.serviceLabel, item.title, item.description, item.implementation]
            .join(" ")
            .toLowerCase()
            .includes(needle);
        })
        .slice(0, limit)
        .map(({ id, service: capabilityService, serviceLabel, title, description, implementation, mutating: isMutating, serviceStatus, inputSchema }) => ({
          id,
          service: capabilityService,
          serviceLabel,
          title,
          description,
          implementation,
          mutating: isMutating,
          serviceStatus,
          inputSchema,
        }));
      return textResult({ count: matches.length, matches });
    },
  );

  server.registerTool(
    "describe_capability",
    {
      title: "Describe a capability",
      description: "Show the full input contract, required Google scopes and docs link for one capability id.",
      inputSchema: { capability_id: z.string().min(1).describe("Capability id, e.g. gmail.send") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ capability_id }) => {
      const entry = findCapability(capability_id);
      if (!entry) throw new Error(`Unknown capability \"${capability_id}\". Known ids: ${capabilityCatalog().map((item) => item.id).join(", ")}`);
      return textResult({
        id: entry.capability.id,
        title: entry.capability.title,
        description: entry.capability.description,
        service: entry.adapter.service,
        serviceStatus: entry.adapter.status,
        statusNote: entry.adapter.statusNote,
        docsUrl: entry.adapter.docsUrl,
        mutating: Boolean(entry.capability.mutating),
        scopes: entry.capability.scopes,
        input: capabilityCatalog().find((item) => item.id === capability_id)?.inputSchema,
      });
    },
  );

  server.registerTool(
    "call_capability",
    {
      title: "Call a Google capability",
      description:
        "Run any Google Nexus capability against the connected Google account. Pass the capability id from list_capabilities and its input object. This is the single entry point for reading and writing Gmail, Drive, Docs, Sheets, Slides, Calendar, Tasks, Contacts, Meet, Chat, Forms, Apps Script and the generative media adapters.",
      inputSchema: {
        capability_id: z.string().min(1).describe("Capability id, e.g. drive.search"),
        input: z.record(z.unknown()).optional().describe("Capability input object."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ capability_id, input }) => {
      try {
        const result = await runCapability({ userId, capabilityId: capability_id, input: input ?? {}, actor: "mcp" });
        return textResult(result ?? { ok: true });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "batch_call_capabilities",
    {
      title: "Run multiple Google capabilities",
      description:
        "Run several Google Nexus capabilities sequentially in one MCP round trip. Use this when an agent needs a small workflow such as Drive search followed by Docs read or Tasks creation. Calls execute in order and each result is returned separately.",
      inputSchema: {
        calls: z.array(z.object({
          capability_id: z.string().min(1),
          input: z.record(z.unknown()).optional(),
        })).min(1).max(20).describe("Ordered capability calls to execute."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ calls }) => {
      const results: Array<{ index: number; capability_id: string; success: boolean; result?: unknown; error?: string }> = [];
      for (const [index, call] of calls.entries()) {
        try {
          const result = await runCapability({ userId, capabilityId: call.capability_id, input: call.input ?? {}, actor: "mcp" });
          results.push({ index, capability_id: call.capability_id, success: true, result });
        } catch (error) {
          results.push({ index, capability_id: call.capability_id, success: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return textResult({
        ok: results.every((item) => item.success),
        completed: results.filter((item) => item.success).length,
        failed: results.filter((item) => !item.success).length,
        results,
      });
    },
  );

  server.registerTool(
    "connection_status",
    {
      title: "Google connection status",
      description: "Report which Google account is connected, whether its grant is healthy, and which services are ready. Use this when a call fails with a connection or permission error.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const status = await nexusStatus(userId);
      return textResult({
        connection: status.connection,
        oauthConfigured: status.oauthConfigured,
        geminiConfigured: status.geminiConfigured,
        services: status.services.map((service) => ({ service: service.service, status: service.status, ready: service.ready })),
      });
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export { RESOURCE_URL };
