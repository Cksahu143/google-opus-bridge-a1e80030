import { z } from "zod";

import { githubJson } from "@/lib/nexus/github.server";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * GitHub REST API — direct code editing for Claude: read files, commit
 * changes, branch, and open pull requests. Authenticated with a
 * fine-grained personal access token (GITHUB_TOKEN env var), not Google
 * OAuth, so this adapter needs no Google scopes at all.
 * https://docs.github.com/en/rest
 */
export const githubAdapter = defineAdapter({
  service: "github",
  label: "GitHub",
  description:
    "Read files and repos, and commit real edits (create/update files, branches, pull requests).",
  status: "requires-configuration",
  statusNote:
    "Official GitHub REST API v3. Needs GITHUB_TOKEN set as an environment secret (a fine-grained PAT scoped to only the repos it should touch) — never committed to source or pasted in chat.",
  docsUrl: "https://docs.github.com/en/rest",
  requiresGoogleAuth: false,
  healthCheck: async () => {
    const user = await githubJson<{ login: string }>("user");
    return { ok: true, detail: `Authenticated as ${user.login}` };
  },
  capabilities: [
    defineCapability({
      id: "github.list_my_repos",
      title: "List my repositories",
      description:
        "List every repository the authenticated token can see, including private ones — unlike browsing github.com/<user> unauthenticated, which only shows public repos.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        visibility: z.enum(["all", "public", "private"]).default("all"),
        perPage: z.number().int().min(1).max(100).default(50),
      }),
      run: (_ctx, input) =>
        githubJson(
          `user/repos?visibility=${input.visibility}&per_page=${input.perPage}&sort=updated`,
        ),
    }),
    defineCapability({
      id: "github.create_repo",
      title: "Create a new repository",
      description:
        "Create a new GitHub repository under the authenticated account (or an org it belongs to).",
      implementation: "google-rest-api",
      scopes: [],
      mutating: true,
      input: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        org: z
          .string()
          .optional()
          .describe("Create under this org instead of the token owner's personal account."),
        private: z.boolean().default(true),
        autoInit: z
          .boolean()
          .default(true)
          .describe("Initialize with a README so the repo isn't empty."),
      }),
      run: (_ctx, input) =>
        githubJson(input.org ? `orgs/${input.org}/repos` : "user/repos", {
          method: "POST",
          body: {
            name: input.name,
            ...(input.description ? { description: input.description } : {}),
            private: input.private,
            auto_init: input.autoInit,
          },
        }),
    }),
    defineCapability({
      id: "github.get_repo",
      title: "Get repository info",
      description: "Read a repository's metadata (default branch, description, visibility, etc).",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({ owner: z.string().min(1), repo: z.string().min(1) }),
      run: (_ctx, input) => githubJson(`repos/${input.owner}/${input.repo}`),
    }),
    defineCapability({
      id: "github.list_files",
      title: "List files in a directory",
      description: "List files and folders at a path in a repo (root if path is omitted).",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().default(""),
        ref: z
          .string()
          .optional()
          .describe("Branch, tag, or commit SHA. Defaults to the default branch."),
      }),
      run: (_ctx, input) =>
        githubJson(
          `repos/${input.owner}/${input.repo}/contents/${input.path}${input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""}`,
        ),
    }),
    defineCapability({
      id: "github.read_file",
      title: "Read a file",
      description:
        "Read one file's decoded text content and its blob SHA (needed to update it later).",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        ref: z.string().optional(),
      }),
      run: async (_ctx, input) => {
        const file = await githubJson<{
          content?: string;
          encoding?: string;
          sha: string;
          size: number;
        }>(
          `repos/${input.owner}/${input.repo}/contents/${input.path}${input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""}`,
        );
        const text =
          file.content && file.encoding === "base64"
            ? Buffer.from(file.content, "base64").toString("utf8")
            : "";
        return { path: input.path, sha: file.sha, size: file.size, content: text };
      },
    }),
    defineCapability({
      id: "github.create_or_update_file",
      title: "Create or update a file",
      description:
        "Commit a file's content directly to a branch. To update an existing file, pass the sha from github.read_file — GitHub rejects the write without it.",
      implementation: "google-rest-api",
      scopes: [],
      mutating: true,
      input: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        content: z.string(),
        message: z.string().min(1),
        branch: z.string().optional(),
        sha: z.string().optional().describe("Required when overwriting an existing file."),
      }),
      run: (_ctx, input) =>
        githubJson(`repos/${input.owner}/${input.repo}/contents/${input.path}`, {
          method: "PUT",
          body: {
            message: input.message,
            content: Buffer.from(input.content, "utf8").toString("base64"),
            ...(input.branch ? { branch: input.branch } : {}),
            ...(input.sha ? { sha: input.sha } : {}),
          },
        }),
    }),
    defineCapability({
      id: "github.create_branch",
      title: "Create a branch",
      description:
        "Create a new branch from an existing ref (defaults to the repo's default branch).",
      implementation: "google-rest-api",
      scopes: [],
      mutating: true,
      input: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        newBranch: z.string().min(1),
        fromRef: z.string().optional(),
      }),
      run: async (_ctx, input) => {
        const base =
          input.fromRef ??
          (await githubJson<{ default_branch: string }>(`repos/${input.owner}/${input.repo}`))
            .default_branch;
        const baseRef = await githubJson<{ object: { sha: string } }>(
          `repos/${input.owner}/${input.repo}/git/ref/heads/${encodeURIComponent(base)}`,
        );
        return githubJson(`repos/${input.owner}/${input.repo}/git/refs`, {
          method: "POST",
          body: { ref: `refs/heads/${input.newBranch}`, sha: baseRef.object.sha },
        });
      },
    }),
    defineCapability({
      id: "github.list_branches",
      title: "List branches",
      description: "List a repository's branches.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        perPage: z.number().int().min(1).max(100).default(30),
      }),
      run: (_ctx, input) =>
        githubJson(`repos/${input.owner}/${input.repo}/branches?per_page=${input.perPage}`),
    }),
    defineCapability({
      id: "github.create_pull_request",
      title: "Open a pull request",
      description: "Open a pull request from one branch into another.",
      implementation: "google-rest-api",
      scopes: [],
      mutating: true,
      input: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        title: z.string().min(1),
        head: z.string().min(1).describe("Branch containing the changes."),
        base: z.string().min(1).describe("Branch to merge into, e.g. 'main'."),
        body: z.string().optional(),
        draft: z.boolean().default(false),
      }),
      run: (_ctx, input) =>
        githubJson(`repos/${input.owner}/${input.repo}/pulls`, {
          method: "POST",
          body: {
            title: input.title,
            head: input.head,
            base: input.base,
            body: input.body ?? "",
            draft: input.draft,
          },
        }),
    }),
    defineCapability({
      id: "github.search_code",
      title: "Search code",
      description:
        "Search code across a repository (or org/user, if scoped in the query) using GitHub's code search syntax.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        query: z.string().min(1).describe("e.g. 'lyria repo:owner/name'"),
        perPage: z.number().int().min(1).max(50).default(10),
      }),
      run: (_ctx, input) =>
        githubJson(`search/code?q=${encodeURIComponent(input.query)}&per_page=${input.perPage}`),
    }),
  ],
});

export default githubAdapter;
