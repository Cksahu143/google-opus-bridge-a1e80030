# NotebookLM Web Bridge on Vercel

This project now includes a Vercel Python Function at `api/notebooklm.py` that uses the maintained `notebooklm-py` package rather than reimplementing NotebookLM's protocol.

## Runtime

- Frontend: existing Vite/Lovable application.
- Backend: Vercel Python Function at `/api/notebooklm`.
- Dependency: `notebooklm-py[headless]==0.8.2`.
- Authentication to the web app: existing Supabase session JWT.
- Authentication to NotebookLM: server-side `NOTEBOOKLM_MASTER_TOKEN_JSON`.

## Why the master token is server-side

`notebooklm-py` documents the master-token flow as the headless path: a one-time browser bootstrap creates a durable master token, and `auth refresh --verify` can mint a fresh web session from that token without a browser on the server. The token is a full-account credential and must never be placed in a `VITE_*` variable, committed to Git, returned by an API response, or logged.

## Web API

The current web UI uses:

- `GET /api/notebooklm?action=list`
- `POST {action:"get", notebookId}`
- `POST {action:"create", title}`
- `POST {action:"delete", notebookId}`
- `POST {action:"ask", notebookId, question}`
- `POST {action:"sources", notebookId}`
- `POST {action:"add-url", notebookId, url, wait}`
- `POST {action:"add-text", notebookId, text, title, wait}`
- `POST {action:"delete-source", sourceId}`

All requests require the existing Supabase access token. Delete operations also require an explicit browser confirmation in the UI.

## Deployment requirement

Vercel must have these server-side variables configured:

- `SUPABASE_URL` (or the existing `VITE_SUPABASE_URL`)
- `SUPABASE_ANON_KEY` (or the existing `VITE_SUPABASE_PUBLISHABLE_KEY`)
- `NOTEBOOKLM_MASTER_TOKEN_JSON`

The repository intentionally does not contain the value of `NOTEBOOKLM_MASTER_TOKEN_JSON`.

## Authentication boundary

The web app cannot manufacture a NotebookLM master token from an ordinary Google OAuth session. The upstream `notebooklm-py` project documents one irreducible browser bootstrap to obtain the durable token. After that bootstrap, the Vercel runtime can operate headlessly.

## Current limitations

Vercel serverless invocations are ephemeral, so the implementation reconstructs a temporary profile for each request and refreshes authentication from the durable master token. This is intentionally single-tenant and should not be treated as a multi-user credential store. A future multi-tenant version should store one protected credential/profile per authenticated user and serialize concurrent refreshes per account.

The browser-provider gateway remains in the repository for legacy compatibility, but it is not the core of this web integration.
