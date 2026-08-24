import { z } from "zod";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";
import { SCOPES } from "@/lib/nexus/scopes";

const project = (value?: string) => value?.trim() || import.meta.env["VITE_GOOGLE_CLOUD_PROJECT"] || "";
const endpoint = (location: string) => `${location}-discoveryengine.googleapis.com`;
const parent = (projectId: string, location: string) => `projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}`;
const requireProject = (value?: string) => { const id = project(value); if (!id) throw new Error("Set VITE_GOOGLE_CLOUD_PROJECT or pass projectId for Gemini Notebook Enterprise."); return id; };

export const notebookEnterpriseAdapter = defineAdapter({
  service: "notebook-enterprise",
  label: "Gemini Notebook Enterprise",
  description: "Official Google Cloud API connector for Gemini Notebook Enterprise notebooks, sources and audio overviews.",
  status: "requires-configuration",
  statusNote: "Requires Gemini Notebook Enterprise setup/licensing, Discovery Engine API enabled, a Google Cloud project, and the required IAM role. The API is currently Preview/Pre-GA.",
  docsUrl: "https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-notebooks",
  capabilities: [
    defineCapability({
      id: "notebook_enterprise.create",
      title: "Create an enterprise notebook",
      description: "Create a real Gemini Notebook Enterprise notebook in Google Cloud.",
      implementation: "google-rest-api",
      scopes: [SCOPES.discoveryEngineReadWrite],
      mutating: true,
      input: z.object({ projectId: z.string().optional(), location: z.string().default("global"), title: z.string().min(1) }),
      run: async (ctx, input) => { const p = requireProject(input.projectId); return ctx.api(`https://${endpoint(input.location)}/v1alpha/${parent(p, input.location)}/notebooks`, { method: "POST", body: { title: input.title } }); },
    }),
    defineCapability({
      id: "notebook_enterprise.list",
      title: "List enterprise notebooks",
      description: "List recently viewed Gemini Notebook Enterprise notebooks.",
      implementation: "google-rest-api",
      scopes: [SCOPES.discoveryEngineReadWrite],
      input: z.object({ projectId: z.string().optional(), location: z.string().default("global") }),
      run: async (ctx, input) => { const p = requireProject(input.projectId); return ctx.api(`https://${endpoint(input.location)}/v1alpha/${parent(p, input.location)}/notebooks:listRecentlyViewed`); },
    }),
    defineCapability({
      id: "notebook_enterprise.get",
      title: "Get an enterprise notebook",
      description: "Retrieve a Gemini Notebook Enterprise notebook by id.",
      implementation: "google-rest-api",
      scopes: [SCOPES.discoveryEngineReadWrite],
      input: z.object({ projectId: z.string().optional(), location: z.string().default("global"), notebookId: z.string().min(1) }),
      run: async (ctx, input) => { const p = requireProject(input.projectId); return ctx.api(`https://${endpoint(input.location)}/v1alpha/${parent(p, input.location)}/notebooks/${encodeURIComponent(input.notebookId)}`); },
    }),
    defineCapability({
      id: "notebook_enterprise.add_sources",
      title: "Add enterprise notebook sources",
      description: "Add Google Docs, Slides, raw text, web pages or YouTube videos as real Notebook Enterprise sources.",
      implementation: "google-rest-api",
      scopes: [SCOPES.discoveryEngineReadWrite, SCOPES.drive],
      mutating: true,
      input: z.object({ projectId: z.string().optional(), location: z.string().default("global"), notebookId: z.string().min(1), sources: z.array(z.discriminatedUnion("type", [z.object({ type: z.literal("drive"), documentId: z.string(), mimeType: z.enum(["application/vnd.google-apps.document", "application/vnd.google-apps.presentation"]), sourceName: z.string().optional() }), z.object({ type: z.literal("text"), content: z.string().min(1), sourceName: z.string().default("Text source") }), z.object({ type: z.literal("web"), url: z.string().url(), sourceName: z.string().optional() }), z.object({ type: z.literal("youtube"), youtubeUrl: z.string().url() })])).min(1).max(20) }),
      run: async (ctx, input) => { const p = requireProject(input.projectId); const userContents = input.sources.map((source) => source.type === "drive" ? { googleDriveContent: { documentId: source.documentId, mimeType: source.mimeType, sourceName: source.sourceName } } : source.type === "text" ? { textContent: { sourceName: source.sourceName, content: source.content } } : source.type === "web" ? { webContent: { url: source.url, sourceName: source.sourceName } } : { videoContent: { youtubeUrl: source.youtubeUrl } }); return ctx.api(`https://${endpoint(input.location)}/v1alpha/${parent(p, input.location)}/notebooks/${encodeURIComponent(input.notebookId)}/sources:batchCreate`, { method: "POST", body: { userContents } }); },
    }),
    defineCapability({
      id: "notebook_enterprise.get_source",
      title: "Get an enterprise notebook source",
      description: "Retrieve source metadata and ingestion status.",
      implementation: "google-rest-api",
      scopes: [SCOPES.discoveryEngineReadWrite],
      input: z.object({ projectId: z.string().optional(), location: z.string().default("global"), notebookId: z.string().min(1), sourceId: z.string().min(1) }),
      run: async (ctx, input) => { const p = requireProject(input.projectId); return ctx.api(`https://${endpoint(input.location)}/v1alpha/${parent(p, input.location)}/notebooks/${encodeURIComponent(input.notebookId)}/sources/${encodeURIComponent(input.sourceId)}`); },
    }),
    defineCapability({
      id: "notebook_enterprise.audio_overview",
      title: "Generate an audio overview",
      description: "Generate the real Notebook Enterprise audio overview from all sources or selected source ids.",
      implementation: "google-rest-api",
      scopes: [SCOPES.discoveryEngineReadWrite],
      mutating: true,
      input: z.object({ projectId: z.string().optional(), location: z.string().default("global"), notebookId: z.string().min(1), sourceIds: z.array(z.string()).optional(), episodeFocus: z.string().optional(), languageCode: z.string().default("en") }),
      run: async (ctx, input) => { const p = requireProject(input.projectId); return ctx.api(`https://${endpoint(input.location)}/v1alpha/${parent(p, input.location)}/notebooks/${encodeURIComponent(input.notebookId)}/audioOverviews`, { method: "POST", body: { generationOptions: { sourceIds: input.sourceIds?.map((id) => ({ id })), episodeFocus: input.episodeFocus, languageCode: input.languageCode } } }); },
    }),
    defineCapability({
      id: "notebook_enterprise.delete_audio_overview",
      title: "Delete an audio overview",
      description: "Delete an existing Notebook Enterprise audio overview.",
      implementation: "google-rest-api",
      scopes: [SCOPES.discoveryEngineReadWrite],
      mutating: true,
      input: z.object({ projectId: z.string().optional(), location: z.string().default("global"), notebookId: z.string().min(1), audioOverviewId: z.string().default("default") }),
      run: async (ctx, input) => { const p = requireProject(input.projectId); return ctx.api(`https://${endpoint(input.location)}/v1alpha/${parent(p, input.location)}/notebooks/${encodeURIComponent(input.notebookId)}/audioOverviews/${encodeURIComponent(input.audioOverviewId)}`, { method: "DELETE" }); },
    }),
  ],
});

export default notebookEnterpriseAdapter;
