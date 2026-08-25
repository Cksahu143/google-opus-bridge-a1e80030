import { z } from "zod";

import { NexusError } from "@/lib/nexus/errors";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * Free NotebookLM integration backed by the MIT-licensed notebooklm-mcp
 * community bridge. NotebookLM has no public consumer API, so this adapter
 * talks to the MCP server over Streamable HTTP.
 *
 * Remote-first configuration:
 *   NOTEBOOKLM_MCP_URL=https://your-host.example/mcp
 *   NOTEBOOKLM_MCP_BEARER_TOKEN=...
 *
 * A local endpoint is intentionally NOT used by default. For development,
 * localhost is allowed only when explicitly configured. Google passwords and
 * browser cookies are never handled by Nexus.
 */

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 30_000;
type Json = Record<string, unknown>;

function endpoint(): string {
  const value = process.env["NOTEBOOKLM_MCP_URL"]?.trim();
  if (!value) {
    throw new NexusError(
      "notebooklm_not_configured",
      "NOTEBOOKLM_MCP_URL is required. Configure a remote HTTPS NotebookLM MCP endpoint; no localhost default is used.",
      503,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NexusError("notebooklm_invalid_url", "NOTEBOOKLM_MCP_URL must be a valid URL.", 500);
  }
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && process.env["NODE_ENV"] !== "production")) {
    throw new NexusError(
      "notebooklm_insecure_endpoint",
      "Remote NotebookLM MCP endpoints must use HTTPS. HTTP is permitted only for explicitly configured local development.",
      500,
    );
  }
  return url.toString();
}

function headers(sessionId?: string | undefined): Record<string, string> {
  const result: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) result["Mcp-Session-Id"] = sessionId;
  const token = process.env["NOTEBOOKLM_MCP_BEARER_TOKEN"]?.trim();
  const url = new URL(endpoint());
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (!local && !token) {
    throw new NexusError(
      "notebooklm_auth_not_configured",
      "NOTEBOOKLM_MCP_BEARER_TOKEN is required for remote NotebookLM MCP endpoints.",
      503,
    );
  }
  if (token) result["authorization"] = `Bearer ${token}`;
  return result;
}

async function parseResponse(
  response: Response,
): Promise<{ body: Json; sessionId?: string | undefined }> {
  const sessionId = response.headers.get("mcp-session-id") ?? undefined;
  const text = await response.text();
  if (!text.trim()) return { body: {}, sessionId };

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const last = dataLines.at(-1);
    if (!last) return { body: {}, sessionId };
    try {
      return { body: JSON.parse(last) as Json, sessionId };
    } catch {
      throw new NexusError(
        "notebooklm_invalid_mcp_response",
        "NotebookLM MCP returned invalid SSE JSON.",
      );
    }
  }

  try {
    return { body: JSON.parse(text) as Json, sessionId };
  } catch {
    throw new NexusError(
      "notebooklm_invalid_mcp_response",
      "NotebookLM MCP returned invalid JSON.",
    );
  }
}

async function postJson(
  url: string,
  body: Json,
  sessionId?: string | undefined,
): Promise<{ body: Json; sessionId?: string | undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(sessionId),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new NexusError(
        "notebooklm_mcp_http_error",
        `NotebookLM MCP returned HTTP ${response.status}.`,
        response.status >= 500 ? 502 : response.status,
      );
    }
    return await parseResponse(response);
  } catch (error) {
    if (error instanceof NexusError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new NexusError(
        "notebooklm_mcp_timeout",
        `NotebookLM MCP request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        504,
      );
    }
    throw new NexusError(
      "notebooklm_mcp_unreachable",
      `Unable to reach the configured NotebookLM MCP endpoint: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function mcpCall(method: string, params: Json = {}): Promise<Json> {
  const url = endpoint();
  const initialized = await postJson(url, {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "google-opus-bridge", version: "1.2.0" },
    },
  });
  const sessionId = initialized.sessionId;

  const parsed = await postJson(
    url,
    {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: method, arguments: params },
    },
    sessionId,
  );

  if (parsed.body["error"]) {
    const error = parsed.body["error"] as Json;
    throw new NexusError(
      "notebooklm_mcp_tool_error",
      `${String(error["message"] ?? "NotebookLM MCP tool call failed.")} ${JSON.stringify(error)}`,
      502,
    );
  }
  const result = parsed.body["result"] as Json | undefined;
  if (!result)
    throw new NexusError("notebooklm_mcp_empty_result", "NotebookLM MCP returned no tool result.");
  return result;
}

function unwrap(result: Json): unknown {
  if (result["structuredContent"] !== undefined) return result["structuredContent"];
  const content = result["content"];
  if (Array.isArray(content)) {
    const textParts = content
      .filter(
        (item): item is Json =>
          typeof item === "object" && item !== null && item["type"] === "text",
      )
      .map((item) => String(item["text"] ?? ""));
    if (textParts.length === 1 && textParts[0] !== undefined) {
      try {
        return JSON.parse(textParts[0]);
      } catch {
        return textParts[0];
      }
    }
    if (textParts.length > 1) return textParts.join("\n");
  }
  return result;
}

export const notebooklmNativeAdapter = defineAdapter({
  service: "notebooklm-native",
  label: "NotebookLM (remote MCP)",
  description:
    "Connect Nexus to a remotely hosted NotebookLM MCP server using secure Streamable HTTP and bearer authentication.",
  status: "requires-configuration",
  statusNote:
    "Set NOTEBOOKLM_MCP_URL to an HTTPS MCP endpoint and NOTEBOOKLM_MCP_BEARER_TOKEN to its access token. No Google password or browser cookie is handled by Nexus.",
  docsUrl: "https://github.com/PleasePrompto/notebooklm-mcp",
  capabilities: [
    defineCapability({
      id: "notebooklm.get_health",
      title: "Check NotebookLM authentication",
      description: "Return the remote NotebookLM MCP server health/authentication status.",
      implementation: "mcp-server",
      scopes: [],
      input: z.object({}),
      run: async () => unwrap(await mcpCall("get_health")),
    }),
    defineCapability({
      id: "notebooklm.setup_auth",
      title: "Authenticate NotebookLM",
      description: "Start the NotebookLM MCP browser authentication flow on the remote MCP host.",
      implementation: "mcp-server",
      scopes: [],
      mutating: true,
      input: z.object({ showBrowser: z.boolean().default(true) }),
      run: async (_ctx, input) =>
        unwrap(await mcpCall("setup_auth", { show_browser: input.showBrowser })),
    }),
    defineCapability({
      id: "notebooklm.re_auth",
      title: "Re-authenticate NotebookLM",
      description:
        "Reset the remote NotebookLM browser session and begin a fresh authentication flow.",
      implementation: "mcp-server",
      scopes: [],
      mutating: true,
      input: z.object({ showBrowser: z.boolean().default(true) }),
      run: async (_ctx, input) =>
        unwrap(await mcpCall("re_auth", { show_browser: input.showBrowser })),
    }),
    defineCapability({
      id: "notebooklm.list_notebooks",
      title: "List NotebookLM notebooks",
      description: "List notebooks visible to the authenticated NotebookLM session.",
      implementation: "mcp-server",
      scopes: [],
      input: z.object({}),
      run: async () => unwrap(await mcpCall("list_notebooks")),
    }),
    defineCapability({
      id: "notebooklm.get_notebook",
      title: "Get a NotebookLM notebook",
      description: "Read metadata and source information for a NotebookLM notebook.",
      implementation: "mcp-server",
      scopes: [],
      input: z.object({ notebookId: z.string().min(1) }),
      run: async (_ctx, input) =>
        unwrap(await mcpCall("get_notebook", { notebook_id: input.notebookId })),
    }),
    defineCapability({
      id: "notebooklm.ask",
      title: "Ask NotebookLM",
      description:
        "Ask a question against a real NotebookLM notebook with NotebookLM grounding/citations.",
      implementation: "mcp-server",
      scopes: [],
      input: z.object({
        question: z.string().min(1),
        notebookId: z.string().optional(),
        sessionId: z.string().optional(),
        sourceFormat: z.enum(["none", "inline", "footnotes", "json"]).default("inline"),
        showBrowser: z.boolean().optional(),
      }),
      run: async (_ctx, input) =>
        unwrap(
          await mcpCall("ask_question", {
            question: input.question,
            ...(input.notebookId ? { notebook_id: input.notebookId } : {}),
            ...(input.sessionId ? { session_id: input.sessionId } : {}),
            source_format: input.sourceFormat,
            ...(input.showBrowser !== undefined ? { show_browser: input.showBrowser } : {}),
          }),
        ),
    }),
    defineCapability({
      id: "notebooklm.add_source",
      title: "Add a NotebookLM source",
      description: "Add a URL or pasted text source to a real NotebookLM notebook.",
      implementation: "mcp-server",
      scopes: [],
      mutating: true,
      input: z.object({
        notebookId: z.string().min(1),
        type: z.enum(["url", "text"]),
        value: z.string().min(1),
        title: z.string().optional(),
      }),
      run: async (_ctx, input) =>
        unwrap(
          await mcpCall("add_source", {
            notebook_id: input.notebookId,
            type: input.type,
            ...(input.type === "url" ? { url: input.value } : { text: input.value }),
            ...(input.title ? { title: input.title } : {}),
          }),
        ),
    }),
    defineCapability({
      id: "notebooklm.generate_audio",
      title: "Generate a NotebookLM Audio Overview",
      description: "Generate an Audio Overview in a real NotebookLM notebook.",
      implementation: "mcp-server",
      scopes: [],
      mutating: true,
      input: z.object({ notebookId: z.string().min(1), customPrompt: z.string().optional() }),
      run: async (_ctx, input) =>
        unwrap(
          await mcpCall("generate_audio", {
            notebook_id: input.notebookId,
            ...(input.customPrompt ? { custom_prompt: input.customPrompt } : {}),
          }),
        ),
    }),
    defineCapability({
      id: "notebooklm.download_audio",
      title: "Download a NotebookLM Audio Overview",
      description: "Download the latest Audio Overview through the remote MCP server.",
      implementation: "mcp-server",
      scopes: [],
      mutating: true,
      input: z.object({ notebookId: z.string().min(1), destinationDir: z.string().optional() }),
      run: async (_ctx, input) =>
        unwrap(
          await mcpCall("download_audio", {
            notebook_id: input.notebookId,
            ...(input.destinationDir ? { destination_dir: input.destinationDir } : {}),
          }),
        ),
    }),
  ],
});

export default notebooklmNativeAdapter;
