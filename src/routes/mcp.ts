import { createFileRoute } from "@tanstack/react-router";
import { createMcpHandler } from "@/lib/mcp";

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      GET: async ({ request }) => createMcpHandler(request),
      POST: async ({ request }) => createMcpHandler(request),
      DELETE: async ({ request }) => createMcpHandler(request),
    },
  },
});
