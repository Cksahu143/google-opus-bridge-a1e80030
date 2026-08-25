import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";

import { textResult } from "../nexus";
import { capabilityCatalog } from "@/lib/nexus/registry";

export default defineTool({
  name: "search_capabilities",
  title: "Search Google capabilities",
  description:
    "Find Google Nexus capabilities by service, name, description, or implementation. Use this before call_capability when you know what you want to do but not the exact capability id.",
  inputSchema: {
    query: z
      .string()
      .trim()
      .optional()
      .describe("Text to match against capability id, service, title, or description."),
    service: z
      .string()
      .trim()
      .optional()
      .describe("Optional service filter such as drive, gmail, calendar, tasks, or github."),
    mutating: z
      .boolean()
      .optional()
      .describe("If set, return only read-only or mutating capabilities."),
    limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of matches."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ query, service, mutating, limit }) => {
    const needle = query?.toLowerCase();
    const serviceNeedle = service?.toLowerCase();

    const matches = capabilityCatalog()
      .filter((item) => !serviceNeedle || item.service.toLowerCase() === serviceNeedle)
      .filter((item) => mutating === undefined || item.mutating === mutating)
      .filter((item) => {
        if (!needle) return true;
        const haystack = [
          item.id,
          item.service,
          item.serviceLabel,
          item.title,
          item.description,
          item.implementation,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      })
      .slice(0, limit)
      .map(
        ({
          id,
          service: capabilityService,
          serviceLabel,
          title,
          description,
          implementation,
          mutating: isMutating,
          serviceStatus,
          inputSchema,
        }) => ({
          id,
          service: capabilityService,
          serviceLabel,
          title,
          description,
          implementation,
          mutating: isMutating,
          serviceStatus,
          inputSchema,
        }),
      );

    return textResult({ count: matches.length, matches });
  },
});
