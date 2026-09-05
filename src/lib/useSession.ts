import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

/** Client-side Supabase session, hydration-safe (null until resolved). */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    try {
      supabase.auth
        .getSession()
        .then(({ data }) => {
          if (!active) return;
          setSession(data.session);
          setLoading(false);
        })
        .catch((error) => {
          console.warn("Supabase session unavailable:", error);
          if (active) {
            setSession(null);
            setLoading(false);
          }
        });

      const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
        if (!active) return;
        setSession(next);
        setLoading(false);
      });

      return () => {
        active = false;
        sub.subscription.unsubscribe();
      };
    } catch (error) {
      console.warn("Supabase session unavailable:", error);
      setSession(null);
      setLoading(false);
      return () => {
        active = false;
      };
    }
  }, []);

  return { session, loading, user: session?.user ?? null };
}

/** Only same-origin relative paths are safe post-auth redirect targets. */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
