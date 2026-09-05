import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Compatibility route for older OAuth authorization-path configuration.
 * The canonical Supabase OAuth authorization path is now /oauth/consent.
 */
export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    authorization_id:
      typeof search["authorization_id"] === "string" ? search["authorization_id"] : "",
  }),
  beforeLoad: ({ search }) => {
    if (!search.authorization_id) {
      throw new Error("Missing authorization_id");
    }
    throw redirect({
      to: "/oauth/consent",
      search: { authorization_id: search.authorization_id },
    });
  },
});
