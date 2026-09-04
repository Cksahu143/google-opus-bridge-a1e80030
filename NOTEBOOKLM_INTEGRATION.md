# NotebookLM Integration — Persistent Remote MCP

Status: **REMOTE MCP ARCHITECTURE READY; CLOUD VM + ONE-TIME AUTH BOOTSTRAP REQUIRED**

The Bridge is now designed so the long-running NotebookLM MCP service does **not** depend on the user's Mac being online. The durable service runs on a persistent Linux VM using the maintained `notebooklm-py` remote MCP deployment. The Mac is only needed for the one-time Google/NotebookLM master-token bootstrap.

## Architecture

```text
                         ┌─────────────────────┐
                         │ ChatGPT / Claude     │
                         │ remote MCP client    │
                         └──────────┬──────────┘
                                    │
                              HTTPS /mcp
                              OAuth
                                    │
                         ┌──────────▼──────────┐
                         │ Cloudflare/Tailscale │
                         │ tunnel                │
                         └──────────┬──────────┘
                                    │
                         ┌──────────▼──────────┐
                         │ Persistent Linux VM  │
                         │ Docker               │
                         │ notebooklm-mcp       │
                         └──────────┬──────────┘
                                    │
                         master-token auth
                                    │
                         ┌──────────▼──────────┐
                         │ Consumer NotebookLM │
                         └─────────────────────┘

Bridge web UI:
Browser → Supabase JWT → notebooklm-proxy → configured NotebookLM service
```

## Why this replaces the old Mac-server design

The previous design required a trusted machine to keep `notebooklm-server` running and reachable. That was operationally fragile and meant the service disappeared when the Mac was asleep or offline.

The new design moves the durable NotebookLM process to a persistent VM. The VM runs Docker continuously and exposes the MCP endpoint through a secure HTTPS tunnel. The repository contains the deployment documentation under `deploy/notebooklm-mcp/` but does not contain credentials or provider-specific secrets.

## Upstream implementation

The remote MCP runtime is intentionally based on the maintained `teng-lin/notebooklm-py` deployment rather than a forked implementation. Its current deployment provides a prebuilt Docker image, persistent profile support, Cloudflare/Tailscale tunnel options, and self-hosted OAuth for ChatGPT.

Reference: https://github.com/teng-lin/notebooklm-py/tree/main/deploy

## Authentication

The recommended unattended path is the upstream master-token flow:

1. On a machine with a browser, run `notebooklm login --master-token` once.
2. Transfer the resulting profile securely to the VM.
3. The VM keeps the master token and writable session state on its private filesystem.
4. `notebooklm-mcp` can refresh the web session without requiring a browser on the VM.

This is deliberately **not** implemented as remote browser automation. The upstream project documents the master token as a durable, full-account credential and recommends a dedicated/throwaway Google account.

## ChatGPT connection

ChatGPT's custom MCP connector uses OAuth rather than a static bearer token. The remote deployment therefore needs:

- `NOTEBOOKLM_MCP_OAUTH_PASSWORD`
- `NOTEBOOKLM_MCP_OAUTH_BASE_URL` set to the bare HTTPS origin
- a public HTTPS tunnel whose whole host routes to the MCP server

The connector URL is:

```text
https://YOUR_HOSTNAME/mcp
```

The OAuth base URL must **not** include `/mcp`.

Current OpenAI documentation says custom MCP apps/connectors are remote and that local MCP servers cannot be connected directly. Full write-capable MCP support is currently plan-dependent; Pro supports read/fetch MCP access while full MCP write/modify support is rolling out to Business, Enterprise and Edu. Verify the current plan requirements before relying on NotebookLM mutation tools.

## Existing Supabase proxy

`supabase/functions/notebooklm-proxy/index.ts` remains an authenticated REST bridge for the existing web application. It is intentionally not the long-running MCP process.

The proxy:

- verifies the signed-in Supabase user;
- keeps its upstream service credential server-side;
- uses a narrow NotebookLM REST allowlist;
- forwards query strings;
- supports URL/text/file/batch source routes;
- provides an authenticated `/health` check.

The MCP deployment and the browser REST bridge should not run competing NotebookLM consumers against the same account/profile. The upstream project documents the account as single-consumer because concurrent session re-minting can invalidate sessions.

## Deployment

See `deploy/notebooklm-mcp/README.md` for the VM architecture and secure deployment contract.

A cloud VM is an external infrastructure dependency. The GitHub repository cannot create or operate a persistent VM on its own. Oracle Cloud currently advertises Always Free compute capacity, subject to account, region, and capacity constraints; another persistent VM provider can be substituted without changing the MCP architecture.

## Security rules

- Never commit `master_token.json`.
- Never commit `storage_state.json`.
- Never commit OAuth state, OAuth passwords, MCP tokens, tunnel tokens, or VM credentials.
- Never put NotebookLM credentials in `VITE_*` variables.
- Never expose the MCP container port directly to the Internet.
- Keep the deployment single-tenant.
- Use HTTPS at the tunnel edge.
- Treat the master token as a full-account credential.

## Current state

Implemented in the repository:

- persistent remote MCP deployment architecture;
- VM deployment runbook;
- separation of long-running MCP service from the Vercel/Supabase web application;
- compatibility notes for ChatGPT OAuth;
- retention of the existing authenticated REST bridge.

Still external to GitHub:

- the persistent VM;
- one-time master-token bootstrap and secure transfer;
- Cloudflare/Tailscale tunnel configuration;
- OAuth password and public hostname;
- final ChatGPT connector registration.
