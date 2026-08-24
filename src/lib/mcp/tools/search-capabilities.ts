import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { textResult } from "../nexus";

export default defineTool({
  name: "search_capabilities",
  title: "Search Google capabilities",
  description: "Search the Nexus capability catalog by service, title, description, or capability id so an agent can discover the correct operation without guessing ids.",
  inputSchema: {
    query: z.string().min(1).describe("Search terms such as 'calendar', 'notebook audio', 'speech', or 'Drive move'."),
    service: z.string().optional().describe("Optional exact service filter."),
    mutating: z.boolean().optional().describe("Optional filter for read-only vs mutating operations."),
    limit: z.number().int().min(1).max(50).default(20),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ query, service, mutating, limit }) => {
    const { capabilityCatalog } = await import("@/lib/nexus/registry");
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = capabilityCatalog()
      .filter((item) => !service || item.service === service)
      .filter((item) => mutating === undefined || item.mutating === mutating)
      .map((item) => {
        const haystack = `${item.id} ${item.service} ${item.serviceLabel} ${item.title} ${item.description}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? (item.id.includes(term) ? 3 : 1) : 0), 0);
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
      .slice(0, limit)
      .map(({ item }) => item);
    return textResult({ query, matches });
  },
});
