import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { safeNext } from "@/lib/useSession";

// Keep production authentication on the canonical Vercel origin.
const PRODUCTION_ORIGIN = "https://google-opus-bridge-a1e80030.vercel.app";

function authOrigin() {
  if (typeof window === "undefined") return PRODUCTION_ORIGIN;
  const hostname = window.location.hostname;
  // Local development should continue to use its own origin.
  if (hostname === "localhost" || hostname === "127.0.0.1") return window.location.origin;
  // Production and preview deployments use the canonical production origin
  // until their redirect URLs are explicitly allowlisted.
  return PRODUCTION_ORIGIN;
}

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({ next: safeNext(search['next']) }),
  head: () => ({
    meta: [
      { title: "Sign in · Google Nexus" },
      {
        name: "description",
        content:
          "Sign in to Google Nexus to connect a Google account and expose the whole Google ecosystem to Claude through one MCP connection.",
      },
      { property: "og:title", content: "Sign in · Google Nexus" },
      {
        property: "og:description",
        content: "Sign in to manage your Google Nexus gateway and Claude connection.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const { next } = Route.useSearch();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const description = hash.get("error_description") ?? hash.get("error");
    if (description) {
      setError(decodeURIComponent(description).replace(/\+/g, " "));
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) window.location.replace(next);
    });
  }, [next]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    if (mode === "signin") {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (signInError) return setError(signInError.message);
      window.location.href = next;
      return;
    }
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${authOrigin()}${next}` },
    });
    setBusy(false);
    if (signUpError) return setError(signUpError.message);
    setMessage("Account created. Check your email if confirmation is required, then sign in.");
    setMode("signin");
  }

  async function google() {
    setBusy(true);
    setError(null);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${authOrigin()}/auth?next=${encodeURIComponent(next)}`,
        queryParams: { prompt: "select_account" },
      },
    });
    if (oauthError) {
      setBusy(false);
      setError(oauthError.message);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-sm">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
          Google Nexus
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          {mode === "signin" ? "Sign in to the gateway" : "Create your gateway account"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account owns the gateway. The Google account Claude uses is connected separately in
          the next step.
        </p>

        <Button
          type="button"
          variant="outline"
          className="mt-6 w-full"
          disabled={busy}
          onClick={google}
        >
          Continue with Google
        </Button>

        <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or email
          <span className="h-px flex-1 bg-border" />
        </div>

        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {message && <p className="text-sm text-muted-foreground">{message}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <button
          type="button"
          className="mt-4 text-sm text-muted-foreground underline underline-offset-4"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
        >
          {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </div>
    </main>
  );
}
