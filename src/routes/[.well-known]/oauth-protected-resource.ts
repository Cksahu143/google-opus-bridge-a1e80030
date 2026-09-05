import { createFileRoute } from "@tanstack/react-router";

const RESOURCE_URL = "https://google-opus-bridge-a1e80030.vercel.app/mcp";
const AUTHORIZATION_SERVER = "https://bjamfhlopmawtnzwwicu.supabase.co/auth/v1";

export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          resource: RESOURCE_URL,
          authorization_servers: [AUTHORIZATION_SERVER],
        }),
    },
  },
});
