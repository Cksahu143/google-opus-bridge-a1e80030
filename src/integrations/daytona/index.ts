import { z } from "zod";

import {
  createSandbox,
  deleteSandbox,
  execCommand,
  listSandboxes,
  runCode,
} from "@/lib/nexus/daytona.server";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * Daytona — real, persistent, Docker/OCI-compatible sandboxes with actual
 * terminal command execution, reachable over plain HTTP. This is the
 * genuine version of "a computer Claude can use for a task": a sandbox
 * created per-task, in an account you own and can see/delete, not a
 * standing environment Claude holds between conversations on its own.
 * https://github.com/daytonaio/daytona
 *
 * Persistence here means a sandbox's filesystem/state survives between
 * calls within the same sandbox id (per Daytona's own "unlimited
 * persistence" design) — not that Claude keeps one running unprompted.
 * Every sandbox this creates is visible and deletable from your own
 * Daytona dashboard at any time.
 */
export const daytonaAdapter = defineAdapter({
  service: "daytona",
  label: "Daytona",
  description:
    "Real, persistent Docker sandboxes with terminal command execution — a genuine computer per task, in your own account.",
  status: "requires-configuration",
  statusNote:
    "Needs DAYTONA_API_KEY as an environment secret (create one at app.daytona.io). Free tier available; sandboxes are visible and deletable from your own Daytona dashboard at any time — this never runs unattended.",
  docsUrl: "https://www.daytona.io/docs/en/",
  requiresGoogleAuth: false,
  capabilities: [
    defineCapability({
      id: "daytona.create_sandbox",
      title: "Create a sandbox",
      description:
        "Create a new persistent Docker sandbox — a real Linux environment with a terminal, for one task or an ongoing project.",
      implementation: "google-rest-api",
      scopes: [],
      mutating: true,
      input: z.object({
        language: z.enum(["python", "typescript", "javascript"]).optional(),
        image: z
          .string()
          .optional()
          .describe(
            "A specific Docker image to base the sandbox on, instead of a language default.",
          ),
      }),
      run: (_ctx, input) =>
        createSandbox({
          ...(input.language ? { language: input.language } : {}),
          ...(input.image ? { image: input.image } : {}),
        }),
    }),
    defineCapability({
      id: "daytona.list_sandboxes",
      title: "List sandboxes",
      description: "List every sandbox currently running or stopped in your Daytona account.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({}),
      run: () => listSandboxes(),
    }),
    defineCapability({
      id: "daytona.exec",
      title: "Run a shell command",
      description:
        "Run a real shell command inside an existing sandbox — the actual terminal-access capability.",
      implementation: "google-rest-api",
      scopes: [],
      mutating: true,
      input: z.object({
        sandboxId: z.string().min(1),
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).max(600).optional(),
      }),
      run: (_ctx, input) =>
        execCommand({
          sandboxId: input.sandboxId,
          command: input.command,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.timeoutSeconds ? { timeout: input.timeoutSeconds } : {}),
        }),
    }),
    defineCapability({
      id: "daytona.run_code",
      title: "Run code",
      description:
        "Run a snippet of Python/JS/TS code inside an existing sandbox and get its output back directly.",
      implementation: "google-rest-api",
      scopes: [],
      mutating: true,
      input: z.object({
        sandboxId: z.string().min(1),
        code: z.string().min(1),
      }),
      run: (_ctx, input) => runCode({ sandboxId: input.sandboxId, code: input.code }),
    }),
    defineCapability({
      id: "daytona.delete_sandbox",
      title: "Delete a sandbox",
      description:
        "Permanently delete a sandbox and its state. Sandboxes are not deleted automatically — clean up when a task is done.",
      implementation: "google-rest-api",
      scopes: [],
      mutating: true,
      input: z.object({ sandboxId: z.string().min(1) }),
      run: async (_ctx, input) => {
        await deleteSandbox(input.sandboxId);
        return { deleted: input.sandboxId };
      },
    }),
  ],
});

export default daytonaAdapter;
