import { NexusError } from "./errors";

/**
 * Hugging Face Inference API — a genuinely free tier (no billing account
 * required for hobby-scale use, unlike Vertex AI), good for smaller models
 * like facebook/musicgen-small. Rate-limited and can have cold-start delays
 * (20-60s) since it's shared infrastructure, but there is no payment wall.
 *
 * NOTE: Hugging Face migrated the Inference API off the old
 * api-inference.huggingface.co domain to the new Inference Providers
 * router. The old domain can fail with a raw Cloudflare origin DNS error
 * (error code: 1016) instead of a normal HTTP error, which masks the real
 * cause -- always use the router domain below.
 * https://huggingface.co/docs/api-inference
 */
const BASE = "https://router.huggingface.co/hf-inference/models";

export function huggingfaceToken(): string | undefined {
  const token = process.env["HUGGINGFACE_API_TOKEN"]?.trim();
  return token ? token : undefined;
}

function requireHuggingfaceToken(): string {
  const token = huggingfaceToken();
  if (!token) {
    throw new NexusError(
      "huggingface_not_configured",
      "This capability needs a Hugging Face access token. Create a free one at https://huggingface.co/settings/tokens and set it as HUGGINGFACE_API_TOKEN in the deployment's environment secrets. Hugging Face's free tier needs no billing account for hobby-scale use.",
      503,
    );
  }
  return token;
}

/** Calls a Hugging Face Inference API model and returns the raw response bytes (e.g. audio/wav, image/png). */
export async function huggingfaceInferBinary(params: {
  model: string;
  input: unknown;
  timeoutMs?: number;
}): Promise<{ mimeType: string; base64: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 60_000);
  try {
    const response = await fetch(`${BASE}/${params.model}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${requireHuggingfaceToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ inputs: params.input }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = text || `Hugging Face API HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // not JSON, use raw text
      }
      throw new NexusError(
        "huggingface_error",
        response.status === 503
          ? `Model is loading (cold start) — try again in a few seconds. (${message})`
          : message,
        response.status === 401 ? 401 : 502,
      );
    }
    const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    return { mimeType, base64: buffer.toString("base64") };
  } finally {
    clearTimeout(timeout);
  }
}
