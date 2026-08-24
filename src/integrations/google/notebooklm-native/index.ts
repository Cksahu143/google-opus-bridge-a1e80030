import { z } from "zod";

import { NexusError } from "@/lib/nexus/errors";
import { defineAdapter, defineCapability, type AdapterContext } from "@/lib/nexus/types";

/**
 * Free NotebookLM integration backed by the MIT-licensed community
 * `notebooklm-mcp` project. NotebookLM has no public consumer API, so this
 * adapter talks to that MCP server over its documented Streamable HTTP
 * transport. Authentication happens in the user's own Chrome profile via
 * the MCP server's setup_auth tool; passwords are never handled by Nexus.
 *
 * Start locally with:
 *   npx notebooklm-mcp@latest --transport http --port 3000
 * and set NOTEBOOKLM_MCP_URL=http://127.0.0.1:3000/mcp
 */

const DEFAULT_URL = "http://127.0.0.1:3000/mcp";
const PROTOCOL_VERSION = "2025-06-18";

type Json = Record<string, unknown>;

function endpoint(): string {
  return process.env.NOTEBOOKLM_MCP_URL?.trim() || DEFAULT_URL;
}

function headers(sessionId?: string): Record<string, string> {
  const result: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) result["Mcp-Session-Id"] = sessionId;
  const token = process.env.NOTEBOOKLM_MCP_BEARER_TOKEN?.trim();
  if (token) result.authorization = `Bearer ${token}`;
  return result;
}

async function parseResponse(response: Response): Promise<{ body: Json; sessionId?: string }> {
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
      throw new NexusError("notebooklm_invalid_mcp_response", "NotebookLM MCP returned invalid SSE JSON.");
    }
  }

  try {
    return { body: JSON.parse(text) as Json, sessionId };
  } catch {
    throw new NexusError("notebooklm_invalid_mcp_response", "NotebookLM MCP returned invalid JSON.");
  }
}

async function mcpCall(method: string, params: Json = {}): Promise<Json> {
  const url = endpoint();
  const initializeId = crypto.randomUUID();
  const init = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "google-opus-bridge", version: "1.0.0" },
      },
    }),
  });
  if (!init.ok) {
    throw new NexusError(
      "notebooklm_mcp_unreachable",
      `NotebookLM MCP is unavailable at ${url} (HTTP ${init.status}). Start notebooklm-mcp in HTTP mode or change NOTEBOOKLM_MCP_URL.`,
      init.status >= 500 ? 502 : init.status,
    );
  }
  const initialized = await parseResponse(init);
  const sessionId = initialized.sessionId;

  const callId = crypto.randomUUID();
  const response = await fetch(url, {
    method: "POST",
    headers: headers(sessionId),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: { name: method, arguments: params },
    }),
  });
  if (!response.ok) {
    throw new NexusError("notebooklm_mcp_call_failed", `NotebookLM MCP returned HTTP ${response.status}.`, response.status);
  }
  const parsed = await parseResponse(response);
  const result = parsed.body.result as Json | undefined;
  if (parsed.body.error) {
    const error = parsed.body.error as Json;
    throw new NexusError(
      "notebooklm_mcp_tool_error",
      String(error.message ?? "NotebookLM MCP tool call failed."),
      502,
      error,
    );
  }
  if (!result) throw new NexusError("notebooklm_mcp_empty_result", "NotebookLM MCP returned no tool result.");
  return result;
}

function unwrap(result: Json): unknown {
  const structured = result.structuredContent;
  if (structured !== undefined) return structured;
  const content = result.content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((item): item is Json => typeof item === "object" && item !== null && item.type === "text")
      .map((item) => String(item.text ?? ""));
    if (textParts.length === 1) {
      try { return JSON.parse(textParts[0]); } catch { return textParts[0]; }
    }
    if (textParts.length > 1) return textParts.join("\n");
  }
  return result;
}

export const notebooklmNativeAdapter = defineAdapter({
  service: "notebooklm-native",
  label: "NotebookLM (free MCP bridge)",
  description: "Connect Nexus to a locally running NotebookLM MCP server using the free NotebookLM web experience and browser-session authentication.",
  status: "requires-configuration",
  statusNote: "Uses the MIT-licensed notebooklm-mcp community bridge. No NotebookLM consumer API key is required. The user authenticates in Chrome through setup_auth; Nexus never receives the Google password.",
  docsUrl: "https://github.com/PleasePrompto/notebooklm-mcp",
  capabilities: [
    defineCapability({
      id: "notebooklm.get_health",
      title: "Check NotebookLM authentication",
      description: "Return the local NotebookLM MCP server health and whether the Google session is authenticated.",
      implementation: "notebooklm-mcp",
      scopes: [],
      input: z.object({}),
      run: async () => unwrap(await mcpCall("get_health")),
    }),
    defineCapability({
      id: "notebooklm.setup_auth",
      title: "Authenticate NotebookLM",
      description: "Open the NotebookLM MCP browser login flow. The user completes Google sign-in in Chrome; passwords are never passed to Nexus.",
      implementation: "notebooklm-mcp",
      scopes: [],
      mutating: true,
      input: z.object({
        showBrowser: z.boolean().default(true),
      }),
      run: async (_ctx, input) => unwrap(await mcpCall("setup_auth", { show_browser: input.showBrowser })),
    }),
    defineCapability({
      id: "notebooklm.re_auth",
      title: "Re-authenticate NotebookLM",
      description: "Reset the NotebookLM MCP browser session and start a fresh Google login.",
      implementation: "notebooklm-mcp",
      scopes: [],
      mutating: true,
      input: z.object({ showBrowser: z.boolean().default(true) }),
      run: async (_ctx, input) => unwrap(await mcpCall("re_auth", { show_browser: input.showBrowser })),
    }),
    defineCapability({
      id: "notebooklm.list_notebooks",
      title: "List NotebookLM notebooks",
      description: "List notebooks visible to the authenticated NotebookLM session.",
      implementation: "notebooklm-mcp",
      scopes: [],
      input: z.object({}),
      run: async () => unwrap(await mcpCall("list_notebooks")),
    }),
    defineCapability({
      id: "notebooklm.get_notebook",
      title: "Get a NotebookLM notebook",
      description: "Read metadata and source information for a NotebookLM notebook.",
      implementation: "notebooklm-mcp",
      scopes: [],
      input: z.object({ notebookId: z.string().min(1) }),
      run: async (_ctx, input) => unwrap(await mcpCall("get_notebook", { notebook_id: input.notebookId })),
    }),
    defineCapability({
      id: "notebooklm.ask",
      title: "Ask NotebookLM",
      description: "Ask a question against a real NotebookLM notebook, preserving NotebookLM's own grounding and citations.",
      implementation: "notebooklm-mcp",
      scopes: [],
      input: z.object({
        question: z.string().min(1),
        notebookId: z.string().optional(),
        sessionId: z.string().optional(),
        sourceFormat: z.enum(["none", "inline", "footnotes", "json"]).default("inline"),
        showBrowser: z.boolean().optional(),
      }),
      run: async (_ctx, input) => unwrap(await mcpCall("ask_question", {
        question: input.question,
        ...(input.notebookId ? { notebook_id: input.notebookId } : {}),
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        source_format: input.sourceFormat,
        ...(input.showBrowser !== undefined ? { show_browser: input.showBrowser } : {}),
      })),
    }),
    defineCapability({
      id: "notebooklm.add_source",
      title: "Add a NotebookLM source",
      description: "Add a URL or pasted text source to a real NotebookLM notebook.",
      implementation: "notebooklm-mcp",
      scopes: [],
      mutating: true,
      input: z.object({
        notebookId: z.string().min(1),
        type: z.enum(["url", "text"]),
        value: z.string().min(1),
        title: z.string().optional(),
      }),
      run: async (_ctx, input) => unwrap(await mcpCall("add_source", {
        notebook_id: input.notebookId,
        type: input.type,
        ...(input.type === "url" ? { url: input.value } : { text: input.value }),
        ...(input.title ? { title: input.title } : {}),
      })),
    }),
    defineCapability({
      id: "notebooklm.generate_audio",
      title: "Generate a NotebookLM Audio Overview",
      description: "Generate an Audio Overview in a real NotebookLM notebook.",
      implementation: "notebooklm-mcp",
      scopes: [],
      mutating: true,
      input: z.object({ notebookId: z.string().min(1), customPrompt: z.string().optional() }),
      run: async (_ctx, input) => unwrap(await mcpCall("generate_audio", {
        notebook_id: input.notebookId,
        ...(input.customPrompt ? { custom_prompt: input.customPrompt } : {}),
      })),
    }),
    defineCapability({
      id: "notebooklm.download_audio",
      title: "Download a NotebookLM Audio Overview",
      description: "Download the most recent generated Audio Overview to a local path on the machine running the MCP bridge.",
      implementation: "notebooklm-mcp",
      scopes: [],
      mutating: true,
      input: z.object({ notebookId: z.string().min(1), destinationDir: z.string().optional() }),
      run: async (_ctx, input) => unwrap(await mcpCall("download_audio", {
        notebook_id: input.notebookId,
        ...(input.destinationDir ? { destination_dir: input.destinationDir } : {}),
      })),
    }),
  ],
});

export default notebooklmNativeAdapter;
