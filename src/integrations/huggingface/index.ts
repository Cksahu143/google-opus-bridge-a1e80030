import { z } from "zod";

import { huggingfaceInferBinary } from "@/lib/nexus/huggingface.server";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * Hugging Face Inference API — the genuinely free-tier option in this
 * connector: no billing account required for hobby-scale requests, unlike
 * Vertex AI (Lyria) or Replicate (pay-as-you-go). Trade-off is shared,
 * rate-limited infrastructure with cold starts, so it suits short clips and
 * occasional use rather than production volume.
 *
 * NOTE: Hugging Face's Inference Providers system means any given model is
 * only servable if at least one provider (fal, Novita, Together, etc.) has
 * deployed it. facebook/musicgen-small is NOT currently served by any
 * provider (confirmed against huggingface.co/facebook/musicgen-small —
 * there's an open community request asking for provider support that has
 * not been fulfilled). Calling it returns "Model not supported by provider
 * hf-inference", not a config problem on this end. Use run_model with a
 * model that IS currently provider-hosted instead, or fall back to
 * replicate.generate_music / replicate.generate_song for produced audio.
 * https://huggingface.co/docs/api-inference
 */
export const huggingfaceAdapter = defineAdapter({
  service: "huggingface",
  label: "Hugging Face",
  description: "Free-tier image generation (Stable Diffusion) plus a generic model-runner escape hatch.",
  status: "requires-configuration",
  statusNote:
    "Needs HUGGINGFACE_API_TOKEN as an environment secret (create a free one at huggingface.co/settings/tokens). Unlike Vertex/Lyria, this genuinely needs no billing account for hobby-scale use — but expect cold starts (20-60s) and rate limits since it's shared infrastructure. Not every model on the Hub is servable: only models an Inference Provider has actually deployed will work (see run_model).",
  docsUrl: "https://huggingface.co/docs/api-inference",
  requiresGoogleAuth: false,
  capabilities: [
    defineCapability({
      id: "huggingface.generate_image",
      title: "Generate an image (free tier)",
      description:
        "Text-to-image using Stable Diffusion XL, via Hugging Face's free Inference API.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({ prompt: z.string().min(1) }),
      run: async (_ctx, input) => {
        const result = await huggingfaceInferBinary({
          model: "stabilityai/stable-diffusion-xl-base-1.0",
          input: input.prompt,
          timeoutMs: 90_000,
        });
        return { image: result };
      },
    }),
    defineCapability({
      id: "huggingface.run_model",
      title: "Run any Hugging Face model (free tier)",
      description:
        "Escape hatch: run any Hugging Face model id via the Inference Providers router, for models not covered by the specific capabilities above. Only works if at least one provider has deployed that model — check the model's page on huggingface.co for a working 'Inference Providers' widget before relying on it. Good candidates for text-to-audio/music currently include models like stabilityai/stable-audio-open-1.0; facebook/musicgen-small is NOT provider-hosted as of this writing.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        model: z.string().min(1).describe("Hugging Face model id, e.g. 'stabilityai/stable-audio-open-1.0'"),
        input: z.string().min(1).describe("The text prompt/input to send as the model's `inputs` field"),
        timeoutMs: z.number().int().min(1000).max(120_000).default(90_000),
      }),
      run: async (_ctx, input) => {
        const result = await huggingfaceInferBinary({
          model: input.model,
          input: input.input,
          timeoutMs: input.timeoutMs,
        });
        return { output: result };
      },
    }),
  ],
});

export default huggingfaceAdapter;
