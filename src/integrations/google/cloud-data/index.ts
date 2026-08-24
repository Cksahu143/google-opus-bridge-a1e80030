import { z } from "zod";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";
import { SCOPES } from "@/lib/nexus/scopes";

const project = (value?: string) => value?.trim() || import.meta.env["VITE_GOOGLE_CLOUD_PROJECT"] || "";
const requireProject = (value?: string) => { const id = project(value); if (!id) throw new Error("Set VITE_GOOGLE_CLOUD_PROJECT or pass projectId."); return id; };

export const cloudDataAdapter = defineAdapter({
  service: "cloud-data",
  label: "Google Cloud Data",
  description: "Read-only BigQuery and Cloud Storage connectors for project data and generated assets.",
  status: "requires-configuration",
  statusNote: "Requires a Google Cloud project plus BigQuery API and/or Cloud Storage JSON API enabled, with the connected account granted access to the requested resources.",
  docsUrl: "https://cloud.google.com/products",
  capabilities: [
    defineCapability({
      id: "bigquery.query",
      title: "Run a BigQuery query",
      description: "Run a read-only SQL query in a Google Cloud project.",
      implementation: "google-rest-api",
      scopes: ["https://www.googleapis.com/auth/bigquery.readonly"],
      input: z.object({ projectId: z.string().optional(), query: z.string().min(1), location: z.string().default("US"), maxResults: z.number().int().min(1).max(1000).default(100) }),
      run: async (ctx, input) => { const p = requireProject(input.projectId); return ctx.api(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(p)}/queries`, { method: "POST", body: { query: input.query, useLegacySql: false, location: input.location, maxResults: input.maxResults, timeoutMs: 30000 } }); },
    }),
    defineCapability({
      id: "bigquery.list_datasets",
      title: "List BigQuery datasets",
      description: "List datasets visible to the connected Google account in a project.",
      implementation: "google-rest-api",
      scopes: ["https://www.googleapis.com/auth/bigquery.readonly"],
      input: z.object({ projectId: z.string().optional() }),
      run: async (ctx, input) => { const p = requireProject(input.projectId); return ctx.api(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(p)}/datasets`); },
    }),
    defineCapability({
      id: "cloudstorage.list_objects",
      title: "List Cloud Storage objects",
      description: "List objects in a Cloud Storage bucket, optionally under a prefix.",
      implementation: "google-rest-api",
      scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
      input: z.object({ bucket: z.string().min(1), prefix: z.string().optional(), maxResults: z.number().int().min(1).max(1000).default(100) }),
      run: async (ctx, input) => ctx.api(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(input.bucket)}/o?${new URLSearchParams({ ...(input.prefix ? { prefix: input.prefix } : {}), maxResults: String(input.maxResults) })}`),
    }),
    defineCapability({
      id: "cloudstorage.get_object",
      title: "Read a Cloud Storage object",
      description: "Read an object from Cloud Storage as UTF-8 text when it is a text-like asset.",
      implementation: "google-rest-api",
      scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
      input: z.object({ bucket: z.string().min(1), object: z.string().min(1), maxCharacters: z.number().int().min(1).max(1000000).default(200000) }),
      run: async (ctx, input) => { const response = await ctx.raw(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(input.bucket)}/o/${encodeURIComponent(input.object)}?alt=media`); if (!response.ok) throw new Error(`Cloud Storage read failed: HTTP ${response.status}`); return { bucket: input.bucket, object: input.object, text: (await response.text()).slice(0, input.maxCharacters) }; },
    }),
  ],
});

export default cloudDataAdapter;
