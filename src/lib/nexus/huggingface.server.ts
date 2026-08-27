import { NexusError } from "./errors";

/**
 * Hugging Face Inference API — a genuinely free tier (no billing account
 * required for hobby-scale use, unlike Vertex AI). Rate-limited and can
 * have cold-start delays (20-60s) since it's shared infrastructure, but
 * there is no payment wall.
 *
 * IMPORTANT — Inference Providers routing:
 * Hugging Face migrated off the old api-inference.huggingface.co domain to
 * the Inference Providers router at router.huggingface.co. Two things
 * trip people up here:
 *   1. The old domain can fail with a raw Cloudflare origin DNS error
 *      (error code: 1016) instead of a normal HTTP error, masking the
 *      real cause -- always use the router domain, never the old one.
 *   2. A model is only callable if at least one provider (fal-ai, Novita,
 *      Together, Replicate-as-a-provider, hf-inference, etc.) has actually
 *      deployed it. Many popular models on the Hub (including
 *      facebook/musicgen-small) are NOT deployed by any provider and will
 *      fail with "Model not supported by provider <x>" forever, regardless
 *      of token/billing -- that's a Hugging Face hosting decision, not a
 *      config problem here. Check a model's own Hub page for a working
 *      "Inference Providers" widget before relying on it.
 *   3. To pick a specific provider (or let Hugging Face auto-select the
 *      fastest one), suffix the model id with ":<provider>" or ":auto",
 *      e.g. "black-forest-labs/FLUX.1-dev:fal-ai" or "...:auto". This
 *      module defaults to ":auto" when no provider is given.
 * https://huggingface.co/docs/inference-providers/index
 */
const ROUTER_BASE = "https://router.huggingface.co";

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

/**
 * Calls a Hugging Face Inference Providers model and returns the raw
 * response bytes (e.g. audio/wav, image/png).
 *
 * `model` may optionally include a ":<provider>" suffix (e.g.
 * "black-forest-labs/FLUX.1-dev:fal-ai"). If omitted, ":auto" is used so
 * Hugging Face picks whichever provider currently serves that model
 * fastest -- this matches the default behaviour of Hugging Face's own
 * client SDKs.
 */
export async function huggingfaceInferBinary(params: {
  model: string;
  input: unknown;
  timeoutMs?: number;
}): Promise<{ mimeType: string; base64: string }> {
  const hasProvider = params.model.includes(":");
  const [modelId, provider] = hasProvider
    ? (params.model.split(":") as [string, string])
    : [params.model, "auto"];
  const routerProvider = provider === "auto" ? "hf-inference" : provider;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 60_000);
  try {
    const response = await fetch(`${ROUTER_BASE}/${routerProvider}/models/${modelId}`, {
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
          : `${message} (tried provider "${routerProvider}" — if this model is hosted by a different provider, pass it as "${modelId}:<provider>", e.g. "${modelId}:fal-ai")`,
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
