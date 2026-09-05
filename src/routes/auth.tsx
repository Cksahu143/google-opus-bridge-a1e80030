import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { safeNext } from "@/lib/useSession";

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

    try {
      void supabase.auth
        .getSession()
        .then(({ data }) => {
          if (data.session) window.location.replace(next);
        })
        .catch((sessionError) => {
          console.warn("Supabase auth unavailable:", sessionError);
          setError("Gateway sign-in is not configured yet. The Vercel deployment needs its browser Supabase variables.");
        });
    } catch (sessionError) {
      console.warn("Supabase auth unavailable:", sessionError);
      setError("Gateway sign-in is not configured yet. The Vercel deployment needs its browser Supabase variables.");
    }
  }, [next]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (mode === "signin") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) return setError(signInError.message);
        window.location.href = next;
        return;
      }
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}${next}` },
      });
      if (signUpError) return setError(signUpError.message);
      setMessage("Account created. Check your email if confirmation is required, then sign in.");
      setMode("signin");
    } catch (submitError) {
      console.warn("Supabase auth unavailable:", submitError);
      setError("Gateway sign-in is not configured yet. Configure the browser Supabase variables in Vercel and redeploy.");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    setError(null);
    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth?next=${encodeURIComponent(next)}`,
          queryParams: { prompt: "select_account" },
        },
      });
      if (oauthError) setError(oauthError.message);
    } catch (oauthError) {
      console.warn("Supabase OAuth unavailable:", oauthError);
      setError("Google sign-in is not configured yet. Configure the browser Supabase variables in Vercel and redeploy.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-sm">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">Google Nexus</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          {mode === "signin" ? "Sign in to the gateway" : "Create your gateway account"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account owns the gateway. The Google account Claude uses is connected separately in the next step.
        </p>

        <Button type="button" variant="outline" className="mt-6 w-full" disabled={busy} onClick={google}>
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
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
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
