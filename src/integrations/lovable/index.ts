import type { Provider } from "@supabase/supabase-js";

import { supabase } from "../supabase/client";

type SignInOptions = {
  redirect_uri?: string;
  extraParams?: Record<string, string>;
};

type LegacyProvider = "google" | "apple" | "microsoft" | "lovable";

/**
 * Legacy compatibility export.
 *
 * The project no longer depends on a platform-specific auth provider. Existing
 * callers can keep importing this module while authentication is handled by
 * Supabase directly.
 */
export const lovable = {
  auth: {
    signInWithOAuth: async (provider: LegacyProvider, opts?: SignInOptions) => {
      if (provider === "lovable") {
        return {
          data: null,
          error: new Error("This provider is no longer supported; use Google Nexus authentication."),
        };
      }

      const mappedProvider: Provider = provider === "microsoft" ? "azure" : provider;
      return supabase.auth.signInWithOAuth({
        provider: mappedProvider,
        options: {
          redirectTo: opts?.redirect_uri,
          queryParams: opts?.extraParams,
        },
      });
    },
  },
};
