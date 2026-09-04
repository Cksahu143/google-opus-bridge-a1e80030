# NotebookLM Service Deployment Runbook

This runbook connects the Bridge web app to a real consumer NotebookLM account through `notebooklm-py` and `notebooklm-server`.

## Architecture

```text
Browser
  -> Supabase Edge Function: notebooklm-proxy
  -> private HTTPS endpoint / reverse proxy
  -> notebooklm-server on the trusted machine
  -> NotebookLM using the local Playwright storage state
```

The Google session remains on the trusted machine. The browser receives neither the Google session cookies nor `NOTEBOOKLM_SERVER_TOKEN`.

## 1. Authenticate NotebookLM on the trusted machine

Run the normal `notebooklm` login flow on the machine that will host the service:

```bash
notebooklm login
```

Complete Google sign-in in the real browser window. Do not paste a Google password, cookie, or `storage_state.json` into this repository, the Bridge UI, or chat.

## 2. Start the local REST service

Generate a strong random bearer token and keep it only in the machine's secret/environment manager.

```bash
export NOTEBOOKLM_SERVER_TOKEN='REPLACE_WITH_A_RANDOM_SECRET'
notebooklm-server --port 8000
```

Verify locally:

```bash
curl http://127.0.0.1:8000/healthz
```

The local listener should stay bound to loopback. Do **not** publish TCP port 8000 directly to the Internet.

## 3. Put an HTTPS boundary in front of it

Use a managed reverse proxy or tunnel that terminates TLS and forwards to `http://127.0.0.1:8000`.

A Cloudflare Tunnel is one supported option. A production tunnel should use a stable hostname and an access policy rather than a temporary quick tunnel.

The resulting service URL should look like:

```text
https://notebooklm.example.com
```

The hostname must be reachable by the Supabase Edge Function. A URL such as `http://127.0.0.1:8000` or `http://localhost:8000` will **not** work from the deployed Edge Function because it points to the Edge Function's own runtime, not your Mac.

## 4. Configure Supabase secrets

Set these as Supabase Edge Function secrets, not frontend variables:

- `NOTEBOOKLM_BASE_URL` — the private HTTPS service URL
- `NOTEBOOKLM_SERVER_TOKEN` — exactly the same bearer token used by `notebooklm-server`

For example, using the Supabase CLI after linking the project:

```bash
supabase secrets set NOTEBOOKLM_BASE_URL=https://notebooklm.example.com
supabase secrets set NOTEBOOKLM_SERVER_TOKEN='REPLACE_WITH_THE_SAME_RANDOM_SECRET'
```

Never commit the real values to `.env`, `.env.example`, source code, or GitHub.

## 5. Deploy the Edge Function

From the repository root:

```bash
supabase functions deploy notebooklm-proxy
```

The function is configured to handle CORS preflight itself and then verify the user's Supabase JWT before forwarding requests. The upstream service token is injected server-side.

## 6. Verify through the Bridge

Sign into the Bridge and open the NotebookLM connection page.

Run these checks in order:

1. **Check service** — verifies the authenticated Edge Function can reach `/healthz`.
2. **List my real notebooks** — calls `/v1/notebooks` through the proxy.
3. Create or chat with a notebook only after those two checks succeed.

A successful list proves more than a successful health check: it confirms the HTTPS path, bearer token, NotebookLM authentication state, and `/v1` proxy path all work together.

## Security rules

- Keep Google `storage_state.json` on the trusted machine.
- Keep `NOTEBOOKLM_SERVER_TOKEN` server-side only.
- Do not expose port 8000 directly.
- Do not put the service token in `VITE_*` variables.
- Do not send Google passwords to the Bridge backend.
- Treat NotebookLM session cookies as live credentials.
- Keep this service single-tenant unless an explicit per-user credential architecture is implemented.
- If the NotebookLM session expires, re-run `notebooklm login` on the trusted machine.

## Current implementation boundary

`supabase/functions/notebooklm-proxy/index.ts` intentionally exposes only the NotebookLM notebook/source/chat REST paths needed by the Bridge instead of becoming a general-purpose HTTP proxy.

The consumer NotebookLM integration is unofficial and depends on `notebooklm-py`'s compatibility with NotebookLM's current web/RPC behavior. It is not the same thing as an official Google public API.
