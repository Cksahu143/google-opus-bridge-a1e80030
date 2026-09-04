# NotebookLM Integration — iPad-First Bridge

Status: **web bridge implemented; consumer NotebookLM browser-login handoff is intentionally not treated as credential transfer**

## Goal

The intended user experience is:

```text
 iPad
   ↓
 Google Nexus Bridge
   ↓
 Open official Gemini Notebook / NotebookLM
   ↓
 user signs in normally in the top-level browser
   ↓
 Bridge uses a separately configured, server-side NotebookLM integration
   ↓
 notebooks / questions / sources
```

The Bridge must never capture, copy, return, or store Google browser cookies, bearer tokens, passwords, or other credentials from the iPad browser.

## Important authentication boundary

Signing into the consumer Gemini Notebook / NotebookLM website in Safari or Chrome does **not** automatically grant the Vercel function access to that browser session. The browser session and the server session are separate security boundaries.

The current Vercel web API therefore uses the configured `NOTEBOOKLM_MASTER_TOKEN_JSON` server credential for `notebooklm-py`. The value is server-side only. It is never put in `VITE_*`, localStorage, an API response, or the UI.

This is deliberate: extracting a Google session cookie or bearer credential from a browser after login would turn the Bridge into a credential-capture mechanism and is not part of this project.

## Current web API

`api/notebooklm.py` exposes an authenticated Vercel Python Function at `/api/notebooklm`.

Supported actions:

- `health`
- `list`
- `get`
- `create`
- `delete`
- `ask`
- `sources`
- `add-url`
- `add-text`
- `delete-source`

Every request requires the existing Supabase access token.

The health response reports whether the server-side NotebookLM credential is configured without returning its value.

## Browser gateway

`supabase/functions/notebooklm-browser-gateway` remains available as a provider abstraction for remote browser sessions.

Providers:

- Browserbase
- Steel
- Browserless
- Cloudflare

These sessions are useful for browser testing and other supported automation. They are **not** advertised as a way to bypass Google's authentication protections. If Google rejects a remote browser, the Bridge reports the failure rather than spoofing browser identity or circumventing the protection.

## Why there is no automatic consumer-login handoff

Google's consumer NotebookLM/Gemini Notebook product does not currently expose a public API equivalent to the Gemini Notebook Enterprise API. Google does provide a documented API for **Gemini Notebook Enterprise**, including notebook creation, retrieval, deletion, sharing, and source management. That API is a separate enterprise product and requires its own Google Cloud setup/licensing/IAM. citeturn0search0turn0search1

Therefore the project has two legitimate integration paths:

1. **Consumer NotebookLM:** use the existing `notebooklm-py` server integration with its server-side authentication boundary.
2. **Gemini Notebook Enterprise:** add a separate official Google Cloud adapter if the account/project is actually licensed and configured for that product.

The Enterprise API is documented as Pre-GA and uses Google Cloud authentication. citeturn2view0

## iPad setup

1. Sign into the Google Nexus Bridge normally.
2. Open `/notebooks/connect`.
3. Tap **Open official NotebookLM**.
4. Sign in to Google in the official top-level browser page.
5. Return to Google Nexus.
6. Tap **Refresh status** / **Check connection**.
7. If the server-side NotebookLM integration is configured, the Bridge can use it. If it is not configured, the page clearly reports that the browser login did not transfer a server credential.

No Mac, Terminal, VM, Docker container, or manual cookie/token copying is required by the iPad UI.

## Server configuration

Required for the current `notebooklm-py` web API:

- `SUPABASE_URL` (or the existing Vite Supabase URL)
- `SUPABASE_ANON_KEY` (or the existing Vite Supabase publishable key)
- `NOTEBOOKLM_MASTER_TOKEN_JSON`

`NOTEBOOKLM_MASTER_TOKEN_JSON` is a highly privileged server credential. Keep it in Vercel Environment Variables as a sensitive server-side secret. Never commit or expose it.

The repository's `requirements.txt` pins `notebooklm-py[headless]==0.8.2`.

## Security rules

- Never extract Google cookies from the iPad browser.
- Never return NotebookLM credentials to frontend code.
- Never put NotebookLM credentials in `VITE_*` variables.
- Never commit `master_token.json` or `storage_state.json`.
- Never spoof or bypass Google anti-automation/security controls.
- Treat `NOTEBOOKLM_MASTER_TOKEN_JSON` as a full-account credential.
- Keep consumer NotebookLM and Gemini Notebook Enterprise credentials/configuration separate.

## Enterprise path

If this account is actually using Gemini Notebook Enterprise, the official Google API is a much cleaner long-term adapter. Google documents API operations for notebooks and sources and requires Google Cloud authentication plus the appropriate enterprise setup. citeturn2view0turn0search1

That adapter should be implemented as a separate provider rather than silently treating an Enterprise notebook as a consumer NotebookLM notebook.
