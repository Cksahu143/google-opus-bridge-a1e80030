import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";

import { requireUserId, textResult } from "../nexus";

const requestSchema = z.object({
  capability_id: z.string().min(1),
  input: z.record(z.unknown()).optional(),
});

/**
 * Executes Nexus capabilities in the order supplied by the model.
 * Sequential execution is intentional: a later call may depend on a value
 * created by an earlier call, and it prevents concurrent writes from racing.
 */
export default defineTool({
  name: "batch_call_capabilities",
  title: "Run multiple Google capabilities",
  description:
    "Run several Google Nexus capabilities sequentially in one MCP round trip. Use this when an agent needs a small workflow such as Drive search followed by Docs read or Tasks creation. Calls execute in order and each result is returned separately.",
  inputSchema: {
    calls: z
      .array(requestSchema)
      .min(1)
      .max(20)
      .describe("Ordered capability calls to execute."),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async ({ calls }, ctx) => {
    const userId = requireUserId(ctx);
    const { runCapability } = await import("@/lib/nexus/router.server");

    const results: Array<{
      index: number;
      capability_id: string;
      success: boolean;
      result?: unknown;
      error?: string;
    }> = [];

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      try {
        const result = await runCapability({
          userId,
          capabilityId: call.capability_id,
          input: call.input ?? {},
          actor: "mcp",
        });
        results.push({ index, capability_id: call.capability_id, success: true, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ index, capability_id: call.capability_id, success: false, error: message });
      }
    }

    return textResult({
      ok: results.every((item) => item.success),
      completed: results.filter((item) => item.success).length,
      failed: results.filter((item) => !item.success).length,
      results,
    });
  },
});
