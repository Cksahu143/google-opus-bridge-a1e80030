import { z } from "zod";

import { NexusError } from "@/lib/nexus/errors";
import { collectText, geminiGenerateContent } from "@/lib/nexus/gemini.server";
import { notebookUrl } from "@/lib/nexus/app-url";
import { SCOPES } from "@/lib/nexus/scopes";
import { defineAdapter, defineCapability, type AdapterContext } from "@/lib/nexus/types";

/**
 * NotebookLM has no public API. Nexus implements the same capability — grounded
 * question answering over a chosen set of sources, with citations — on top of
 * documented APIs: Drive/Docs/Sheets for source text extraction and Gemini for
 * grounded synthesis. Notebooks live in this app's database and reference Drive
 * files, so Claude can build and query them through one interface.
 */
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const MAX_SOURCE_CHARS = 120_000;
const GROUNDING_MODEL = "gemini-2.5-flash";

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

interface NotebookRow {
  id: string;
  title: string;
  description: string | null;
  drive_folder_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SourceRow {
  id: string;
  notebook_id: string;
  kind: string;
  title: string;
  reference: string | null;
  cached_text: string | null;
  char_count: number;
}

async function requireNotebook(userId: string, notebookId: string): Promise<NotebookRow> {
  const client = await db();
  const { data, error } = await client
    .from("nexus_notebooks")
    .select("*")
    .eq("id", notebookId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new NexusError("notebook_not_found", `No notebook ${notebookId} for this account.`, 404);
  }
  return data as NotebookRow;
}

async function loadSources(userId: string, notebookId: string): Promise<SourceRow[]> {
  const client = await db();
  const { data, error } = await client
    .from("nexus_notebook_sources")
    .select("*")
    .eq("user_id", userId)
    .eq("notebook_id", notebookId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SourceRow[];
}

const EXPORTABLE: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

/** Extracts plain text from any Drive file Nexus can read as text. */
async function extractDriveText(
  ctx: AdapterContext,
  fileId: string,
): Promise<{ title: string; text: string }> {
  const meta = await ctx.api<{ name: string; mimeType: string }>(
    `${DRIVE_FILES}/${fileId}?fields=name,mimeType`,
  );
  const exportMime = EXPORTABLE[meta.mimeType];
  const url = exportMime
    ? `${DRIVE_FILES}/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `${DRIVE_FILES}/${fileId}?alt=media`;
  const response = await ctx.raw(url);
  if (!response.ok) {
    throw new NexusError(
      "notebook_source_unreadable",
      `Could not read "${meta.name}" as text (HTTP ${response.status}). Docs, Slides, Sheets, text, CSV, JSON and Markdown files work.`,
      response.status === 403 ? 403 : 400,
    );
  }
  const text = (await response.text()).trim();
  if (!text) {
    throw new NexusError("notebook_source_empty", `"${meta.name}" contained no extractable text.`);
  }
  return { title: meta.name, text: text.slice(0, MAX_SOURCE_CHARS) };
}

function buildContext(sources: SourceRow[], budget = 400_000) {
  const used: SourceRow[] = [];
  let total = 0;
  for (const source of sources) {
    if (!source.cached_text) continue;
    if (total + source.cached_text.length > budget) continue;
    total += source.cached_text.length;
    used.push(source);
  }
  const block = used
    .map(
      (source, index) =>
        `[S${index + 1}] ${source.title}${source.reference ? ` (${source.reference})` : ""}\n${source.cached_text}`,
    )
    .join("\n\n---\n\n");
  return {
    block,
    citations: used.map((source, index) => ({
      marker: `S${index + 1}`,
      title: source.title,
      sourceId: source.id,
      kind: source.kind,
      reference: source.reference,
    })),
  };
}

async function grounded(params: { instruction: string; sources: SourceRow[] }) {
  if (params.sources.length === 0) {
    throw new NexusError(
      "notebook_empty",
      "This notebook has no sources yet. Add Drive files or text with notebook.add_source.",
    );
  }
  const { block, citations } = buildContext(params.sources);
  const answer = collectText(
    await geminiGenerateContent(GROUNDING_MODEL, {
      systemInstruction: {
        parts: [
          {
            text: "You answer strictly from the provided sources. Cite every claim with its [S#] marker. If the sources do not contain the answer, say so plainly instead of guessing.",
          },
        ],
      },
      contents: [
        { role: "user", parts: [{ text: `SOURCES:\n${block}\n\nTASK:\n${params.instruction}` }] },
      ],
      generationConfig: { temperature: 0.2 },
    }),
  );
  return { answer, citations, sourcesUsed: citations.length };
}

const MEMORY_NOTEBOOK_TITLE = "Memory";
const MEMORY_SOURCE_TITLE = "Memory Log";

async function findMemoryNotebook(userId: string): Promise<NotebookRow | null> {
  const client = await db();
  const { data, error } = await client
    .from("nexus_notebooks")
    .select("*")
    .eq("user_id", userId)
    .eq("title", MEMORY_NOTEBOOK_TITLE)
    .maybeSingle();
  if (error) throw error;
  return (data as NotebookRow | null) ?? null;
}

async function findOrCreateMemoryNotebook(userId: string): Promise<NotebookRow> {
  const existing = await findMemoryNotebook(userId);
  if (existing) return existing;
  const client = await db();
  const { data, error } = await client
    .from("nexus_notebooks")
    .insert({
      user_id: userId,
      title: MEMORY_NOTEBOOK_TITLE,
      description:
        "Auto-created by memory.remember. A durable, append-only log of things to remember.",
      drive_folder_id: null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as NotebookRow;
}

async function findOrCreateMemoryLog(userId: string, notebookId: string): Promise<SourceRow> {
  const client = await db();
  const { data: existing, error: findError } = await client
    .from("nexus_notebook_sources")
    .select("*")
    .eq("user_id", userId)
    .eq("notebook_id", notebookId)
    .eq("title", MEMORY_SOURCE_TITLE)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return existing as SourceRow;
  const { data, error } = await client
    .from("nexus_notebook_sources")
    .insert({
      user_id: userId,
      notebook_id: notebookId,
      kind: "text",
      title: MEMORY_SOURCE_TITLE,
      reference: null,
      cached_text: "",
      char_count: 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as SourceRow;
}

export const notebooklmAdapter = defineAdapter({
  service: "notebook",
  label: "Grounded notebooks (NotebookLM-style)",
  description:
    "Build notebooks from Drive files and pasted text, then ask grounded questions with citations.",
  status: "partial",
  statusNote:
    "NotebookLM itself has no public API, so Nexus reimplements it: Drive/Docs/Sheets export supplies the source text and Gemini answers strictly from those sources with [S#] citations. Audio Overviews are NotebookLM-only and are not reproduced.",
  docsUrl: "https://developers.google.com/workspace/drive/api/guides/manage-downloads",
  capabilities: [
    defineCapability({
      id: "notebook.create",
      title: "Create a notebook",
      description: "Create a grounded notebook, optionally scoped to a Drive folder.",
      implementation: "gemini-api",
      scopes: [],
      mutating: true,
      input: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        driveFolderId: z.string().optional(),
      }),
      run: async (ctx, input) => {
        const client = await db();
        const { data, error } = await client
          .from("nexus_notebooks")
          .insert({
            user_id: ctx.userId,
            title: input.title,
            description: input.description ?? null,
            drive_folder_id: input.driveFolderId ?? null,
          })
          .select("*")
          .single();
        if (error) throw error;
        return { notebook: data, sources: [], url: notebookUrl(data.id) };
      },
    }),
    defineCapability({
      id: "notebook.list",
      title: "List notebooks",
      description: "List notebooks with their source counts.",
      implementation: "gemini-api",
      scopes: [],
      input: z.object({}),
      run: async (ctx) => {
        const client = await db();
        const { data, error } = await client
          .from("nexus_notebooks")
          .select("*")
          .eq("user_id", ctx.userId)
          .order("updated_at", { ascending: false });
        if (error) throw error;
        const notebooks = (data ?? []) as NotebookRow[];
        // No FK embed: count sources with a separate query so this works
        // regardless of whether PostgREST knows the relationship.
        const { data: sourceRows, error: sourceError } = await client
          .from("nexus_notebook_sources")
          .select("notebook_id")
          .eq("user_id", ctx.userId);
        if (sourceError) throw sourceError;
        const counts = new Map<string, number>();
        for (const row of sourceRows ?? []) {
          counts.set(row.notebook_id, (counts.get(row.notebook_id) ?? 0) + 1);
        }
        return {
          notebooks: notebooks.map((notebook) => ({
            ...notebook,
            sourceCount: counts.get(notebook.id) ?? 0,
            url: notebookUrl(notebook.id),
          })),
        };
      },
    }),
    defineCapability({
      id: "notebook.add_source",
      title: "Add a source",
      description:
        "Add a Drive file (Doc, Slides, Sheet, text, CSV, Markdown) or pasted text to a notebook. Text is extracted and cached for grounding.",
      implementation: "google-rest-api",
      scopes: [SCOPES.drive],
      mutating: true,
      input: z.object({
        notebookId: z.string().min(1),
        driveFileId: z.string().optional(),
        text: z.string().optional(),
        title: z.string().optional(),
      }),
      run: async (ctx, input) => {
        await requireNotebook(ctx.userId, input.notebookId);
        let payload: { kind: string; title: string; reference: string | null; text: string };
        if (input.driveFileId) {
          const extracted = await extractDriveText(ctx, input.driveFileId);
          payload = {
            kind: "drive_file",
            title: input.title ?? extracted.title,
            reference: input.driveFileId,
            text: extracted.text,
          };
        } else if (input.text?.trim()) {
          payload = {
            kind: "text",
            title: input.title ?? "Pasted text",
            reference: null,
            text: input.text.slice(0, MAX_SOURCE_CHARS),
          };
        } else {
          throw new NexusError(
            "notebook_source_required",
            "Provide either driveFileId or text for notebook.add_source.",
          );
        }
        const client = await db();
        const { data, error } = await client
          .from("nexus_notebook_sources")
          .insert({
            user_id: ctx.userId,
            notebook_id: input.notebookId,
            kind: payload.kind,
            title: payload.title,
            reference: payload.reference,
            cached_text: payload.text,
            char_count: payload.text.length,
          })
          .select("id, kind, title, reference, char_count")
          .single();
        if (error) throw error;
        return { source: data };
      },
    }),
    defineCapability({
      id: "notebook.import_folder",
      title: "Import a Drive folder",
      description: "Add every readable file in a Drive folder to a notebook as sources.",
      implementation: "google-rest-api",
      scopes: [SCOPES.drive],
      mutating: true,
      input: z.object({
        notebookId: z.string().min(1),
        driveFolderId: z.string().min(1),
        maxFiles: z.number().int().min(1).max(25).default(10),
      }),
      run: async (ctx, input) => {
        await requireNotebook(ctx.userId, input.notebookId);
        const query = `'${input.driveFolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
        const listing = await ctx.api<{ files?: { id: string; name: string }[] }>(
          `${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=${input.maxFiles}`,
        );
        const client = await db();
        const added: unknown[] = [];
        const skipped: { name: string; reason: string }[] = [];
        for (const file of listing.files ?? []) {
          try {
            const extracted = await extractDriveText(ctx, file.id);
            const { data, error } = await client
              .from("nexus_notebook_sources")
              .insert({
                user_id: ctx.userId,
                notebook_id: input.notebookId,
                kind: "drive_file",
                title: extracted.title,
                reference: file.id,
                cached_text: extracted.text,
                char_count: extracted.text.length,
              })
              .select("id, title, char_count")
              .single();
            if (error) throw error;
            added.push(data);
          } catch (error) {
            skipped.push({ name: file.name, reason: (error as Error).message });
          }
        }
        return { added, skipped };
      },
    }),
    defineCapability({
      id: "notebook.get",
      title: "Get a notebook",
      description:
        "Read one notebook's details and its full source list (previously created notebooks included).",
      implementation: "gemini-api",
      scopes: [],
      input: z.object({ notebookId: z.string().min(1) }),
      run: async (ctx, input) => {
        const notebook = await requireNotebook(ctx.userId, input.notebookId);
        const sources = await loadSources(ctx.userId, input.notebookId);
        return {
          notebook,
          url: notebookUrl(notebook.id),
          sources: sources.map(({ id, kind, title, reference, char_count }) => ({
            id,
            kind,
            title,
            reference,
            char_count,
          })),
        };
      },
    }),
    defineCapability({
      id: "notebook.update",
      title: "Rename or redescribe a notebook",
      description: "Edit an existing notebook's title, description, or linked Drive folder.",
      implementation: "gemini-api",
      scopes: [],
      mutating: true,
      input: z.object({
        notebookId: z.string().min(1),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        driveFolderId: z.string().optional(),
      }),
      run: async (ctx, input) => {
        await requireNotebook(ctx.userId, input.notebookId);
        const patch: {
          updated_at: string;
          title?: string;
          description?: string;
          drive_folder_id?: string;
        } = {
          updated_at: new Date().toISOString(),
        };
        if (input.title !== undefined) patch.title = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.driveFolderId !== undefined) patch.drive_folder_id = input.driveFolderId;
        const client = await db();
        const { data, error } = await client
          .from("nexus_notebooks")
          .update(patch)
          .eq("id", input.notebookId)
          .eq("user_id", ctx.userId)
          .select("*")
          .single();
        if (error) throw error;
        return { notebook: data };
      },
    }),
    defineCapability({
      id: "notebook.ask",
      title: "Ask a notebook",
      description:
        "Answer a question strictly from a notebook's sources, with [S#] citations back to each source.",
      implementation: "gemini-api",
      scopes: [],
      input: z.object({ notebookId: z.string().min(1), question: z.string().min(1) }),
      run: async (ctx, input) => {
        const notebook = await requireNotebook(ctx.userId, input.notebookId);
        const sources = await loadSources(ctx.userId, input.notebookId);
        const result = await grounded({ instruction: input.question, sources });
        return {
          notebook: { id: notebook.id, title: notebook.title },
          question: input.question,
          ...result,
        };
      },
    }),
    defineCapability({
      id: "notebook.summarize",
      title: "Summarize a notebook",
      description:
        "Produce a briefing of a notebook's sources: key points, themes and open questions.",
      implementation: "gemini-api",
      scopes: [],
      input: z.object({
        notebookId: z.string().min(1),
        style: z.enum(["briefing", "outline", "faq", "study-guide"]).default("briefing"),
      }),
      run: async (ctx, input) => {
        const notebook = await requireNotebook(ctx.userId, input.notebookId);
        const sources = await loadSources(ctx.userId, input.notebookId);
        const instructions: Record<string, string> = {
          briefing: "Write a concise briefing document: key points, themes, and open questions.",
          outline: "Write a hierarchical outline of everything the sources cover.",
          faq: "Write the 8 most useful question/answer pairs the sources support.",
          "study-guide": "Write a study guide: core concepts, definitions, and 5 review questions.",
        };
        const result = await grounded({
          instruction: instructions[input.style] as string,
          sources,
        });
        return {
          notebook: { id: notebook.id, title: notebook.title },
          style: input.style,
          ...result,
        };
      },
    }),
    defineCapability({
      id: "notebook.delete_source",
      title: "Remove a source",
      description: "Remove one source from a notebook.",
      implementation: "gemini-api",
      scopes: [],
      mutating: true,
      input: z.object({ notebookId: z.string().min(1), sourceId: z.string().min(1) }),
      run: async (ctx, input) => {
        const client = await db();
        const { error } = await client
          .from("nexus_notebook_sources")
          .delete()
          .eq("user_id", ctx.userId)
          .eq("notebook_id", input.notebookId)
          .eq("id", input.sourceId);
        if (error) throw error;
        return { removed: input.sourceId };
      },
    }),
    defineCapability({
      id: "memory.remember",
      title: "Remember something",
      description:
        "Save a fact/preference/instruction for later. Auto-creates a 'Memory' notebook and a single append-only 'Memory Log' source the first time this is called, then appends a timestamped entry to it on every call after. This is real persistence in Nexus's own database — no separate Google account involved.",
      implementation: "gemini-api",
      scopes: [],
      mutating: true,
      input: z.object({
        content: z.string().min(1),
        tag: z
          .string()
          .optional()
          .describe("Optional short label, e.g. 'preference', 'project:evolved'"),
      }),
      run: async (ctx, input) => {
        const client = await db();
        const notebook = await findOrCreateMemoryNotebook(ctx.userId);
        const source = await findOrCreateMemoryLog(ctx.userId, notebook.id);
        const stamp = new Date().toISOString();
        const line = `[${stamp}]${input.tag ? ` (${input.tag})` : ""} ${input.content.trim()}`;
        const nextText =
          `${source.cached_text ?? ""}${source.cached_text ? "\n" : ""}${line}`.slice(
            -MAX_SOURCE_CHARS,
          );
        const { data, error } = await client
          .from("nexus_notebook_sources")
          .update({ cached_text: nextText, char_count: nextText.length })
          .eq("id", source.id)
          .eq("user_id", ctx.userId)
          .select("id, char_count")
          .single();
        if (error) throw error;
        return {
          remembered: input.content,
          notebookId: notebook.id,
          sourceId: data.id,
          totalMemoryChars: data.char_count,
          url: notebookUrl(notebook.id),
        };
      },
    }),
    defineCapability({
      id: "memory.recall",
      title: "Recall from memory",
      description:
        "Read back what has been remembered. With a question, answers grounded strictly in the memory log with citations; without one, returns the raw log.",
      implementation: "gemini-api",
      scopes: [],
      input: z.object({ question: z.string().optional() }),
      run: async (ctx, input) => {
        const notebook = await findMemoryNotebook(ctx.userId);
        if (!notebook) {
          return { hasMemory: false, message: "Nothing has been remembered yet." };
        }
        const sources = await loadSources(ctx.userId, notebook.id);
        if (input.question) {
          const result = await grounded({ instruction: input.question, sources });
          return { hasMemory: true, question: input.question, ...result };
        }
        const log = sources.find((s) => s.title === MEMORY_SOURCE_TITLE);
        return {
          hasMemory: Boolean(log?.cached_text),
          notebookId: notebook.id,
          log: log?.cached_text ?? "",
        };
      },
    }),
  ],
});

export default notebooklmAdapter;
