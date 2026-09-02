import { NexusError } from "./errors";

/**
 * Client for the Daytona API — real, persistent, Docker/OCI-compatible
 * sandboxes with actual terminal/process execution, reachable over plain
 * HTTP. Verified directly against Daytona's own README and docs (not
 * guessed): https://github.com/daytonaio/daytona
 *
 * Two hosts are involved: app.daytona.io for sandbox lifecycle (create,
 * list, delete), and proxy.app.daytona.io for the "toolbox" — actually
 * running commands inside a given sandbox.
 */
const API_BASE = "https://app.daytona.io/api";
const PROXY_BASE = "https://proxy.app.daytona.io/toolbox";

function daytonaToken(): string | undefined {
  const token = process.env["DAYTONA_API_KEY"]?.trim();
  return token ? token : undefined;
}

function requireDaytonaToken(): string {
  const token = daytonaToken();
  if (!token) {
    throw new NexusError(
      "daytona_not_configured",
      "This capability needs a Daytona API key. Create one at app.daytona.io (API Keys) and set it as DAYTONA_API_KEY in the deployment's environment secrets.",
      503,
    );
  }
  return token;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${requireDaytonaToken()}`,
    "content-type": "application/json",
  };
  const orgId = process.env["DAYTONA_ORGANIZATION_ID"]?.trim();
  if (orgId) headers["X-Daytona-Organization-ID"] = orgId;
  return headers;
}

/**
 * The toolbox/proxy host (proxy.app.daytona.io) does NOT accept the same
 * Bearer API-key auth as the main API — confirmed directly against
 * Daytona's own official docs.daytona.io curl example for
 * /toolbox/{sandboxId}/process/code-run, which shows only a
 * Content-Type header and explicitly no Authorization header at all.
 * Sending a Bearer token there produces exactly the "Bearer token is
 * invalid" error this was fixed for — the proxy validates it against a
 * different scheme than a plain org API key and rejects it outright.
 */
function toolboxHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

async function daytonaJson<T>(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; useApiAuth?: boolean } = {},
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: init.useApiAuth === false ? toolboxHeaders() : authHeaders(),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message =
      (payload as { message?: string } | null)?.message ??
      (typeof payload === "string" && payload ? payload : `Daytona API HTTP ${response.status}`);
    throw new NexusError(
      "daytona_error",
      message,
      response.status === 401 || response.status === 403 ? response.status : 502,
    );
  }
  return payload as T;
}

export interface DaytonaSandbox {
  id: string;
  state?: string;
  [key: string]: unknown;
}

export function createSandbox(params: {
  language?: string;
  image?: string;
  envVars?: Record<string, string>;
}): Promise<DaytonaSandbox> {
  return daytonaJson<DaytonaSandbox>(API_BASE, "/sandbox", {
    body: {
      ...(params.language ? { language: params.language } : {}),
      ...(params.image ? { image: params.image } : {}),
      ...(params.envVars ? { env: params.envVars } : {}),
    },
  });
}

export function listSandboxes(): Promise<DaytonaSandbox[]> {
  return daytonaJson<DaytonaSandbox[]>(API_BASE, "/sandbox", { method: "GET" });
}

export function deleteSandbox(sandboxId: string): Promise<void> {
  return daytonaJson<void>(API_BASE, `/sandbox/${sandboxId}`, { method: "DELETE" });
}

export interface ExecResult {
  result?: string;
  exitCode?: number;
  [key: string]: unknown;
}

export function execCommand(params: {
  sandboxId: string;
  command: string;
  cwd?: string;
  timeout?: number;
}): Promise<ExecResult> {
  return daytonaJson<ExecResult>(PROXY_BASE, `/${params.sandboxId}/process/execute`, {
    body: {
      command: params.command,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.timeout ? { timeout: params.timeout } : {}),
    },
    useApiAuth: false,
  });
}

export function runCode(params: { sandboxId: string; code: string }): Promise<ExecResult> {
  return daytonaJson<ExecResult>(PROXY_BASE, `/${params.sandboxId}/process/code-run`, {
    body: { code: params.code },
    useApiAuth: false,
  });
}

/**
 * Uploads a file into a sandbox via multipart/form-data — confirmed
 * directly against Daytona's own file-system-operations docs curl
 * example (`--header 'Content-Type: multi...'`), not the JSON+base64
 * body originally guessed here. No Authorization header, consistent with
 * every other toolbox/proxy endpoint.
 */
export async function uploadFile(params: {
  sandboxId: string;
  path: string;
  contentBase64: string;
}): Promise<void> {
  const bytes = Buffer.from(params.contentBase64, "base64");
  const form = new FormData();
  form.append("file", new Blob([bytes]), params.path.split("/").pop() ?? "file");

  const response = await fetch(
    `${PROXY_BASE}/${params.sandboxId}/files/upload?path=${encodeURIComponent(params.path)}`,
    { method: "POST", body: form },
  );
  if (!response.ok) {
    throw new NexusError(
      "daytona_upload_failed",
      `Failed to upload file: HTTP ${response.status} ${await response.text()}`,
      502,
    );
  }
}

/**
 * Downloads a file's raw bytes from a sandbox and returns them
 * base64-encoded. Endpoint path confirmed to exist (files/download) in
 * Daytona's docs, though the exact response shape (raw bytes vs a JSON
 * wrapper) was not shown in the available example — this assumes a raw
 * binary response, matching how a plain GET download endpoint normally
 * behaves; if it 404s or returns JSON instead, check
 * docs.daytona.io/en/file-system-operations for the current exact shape.
 */
export async function downloadFile(params: { sandboxId: string; path: string }): Promise<string> {
  const response = await fetch(
    `${PROXY_BASE}/${params.sandboxId}/files/download?path=${encodeURIComponent(params.path)}`,
  );
  if (!response.ok) {
    throw new NexusError(
      "daytona_download_failed",
      `Failed to download file: HTTP ${response.status} ${await response.text()}`,
      502,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}
