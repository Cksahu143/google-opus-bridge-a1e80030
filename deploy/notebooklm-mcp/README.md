# Persistent Remote NotebookLM MCP

This deployment makes NotebookLM available to remote MCP clients without keeping the Mac running.

## Architecture

```text
ChatGPT / Claude
       |
       | HTTPS /mcp + OAuth
       v
Cloudflare Tunnel or Tailscale Funnel
       |
       v
Persistent Linux VM
  └─ Docker
      └─ notebooklm-mcp
          |
          v
   dedicated NotebookLM account
```

The Bridge's Vercel/Supabase application is **not** the long-running NotebookLM process. The VM is the durable execution host. The Mac is used only for the one-time Google authentication bootstrap.

## Important limitation

The repository cannot provision an always-on VM by itself. A cloud compute account is required. A practical low-cost/free target is an Oracle Cloud Always Free VM; availability is subject to the provider's capacity and account/region limits. See the provider documentation before creating resources.

## Upstream implementation

This deployment intentionally uses the maintained `notebooklm-py` remote MCP deployment instead of copying its server implementation into this repository. The upstream deployment supplies a prebuilt Docker image, persistent profile storage, OAuth support for ChatGPT, and Cloudflare/Tailscale tunnel profiles.

Upstream reference: https://github.com/teng-lin/notebooklm-py/tree/main/deploy

## One-time bootstrap

Do this on a machine with a browser, such as the Mac:

```bash
pip install "notebooklm-py[browser,headless]"
notebooklm login --master-token --account YOUR_DEDICATED_NOTEBOOKLM_ACCOUNT
```

This creates a profile containing `master_token.json`. **Never commit this file, paste it into chat, or put it in a Vite/browser environment.** The upstream project treats it as a durable full-account credential and recommends a dedicated/throwaway Google account.

Copy that profile to the VM using a secure file-transfer method. Do not put it in GitHub.

## VM deployment

On the persistent Linux VM:

1. Install Docker and Docker Compose.
2. Create a private directory for the NotebookLM deployment and a `0700` OAuth-state directory.
3. Download the official release `docker-compose.yml` and `env.example` from the `notebooklm-py` release.
4. Configure either Cloudflare Tunnel or Tailscale Funnel.
5. Set the upstream MCP authentication and OAuth variables.
6. Mount the bootstrapped NotebookLM profile read/write so the service can maintain its session state.
7. Start the stack with Docker Compose and enable the selected tunnel profile.
8. Verify the OAuth discovery endpoint and `/mcp` endpoint from the public HTTPS hostname.

The public connector URL is:

```text
https://YOUR_HOSTNAME/mcp
```

For ChatGPT, the upstream deployment requires its self-hosted OAuth mode. The OAuth base URL is the bare HTTPS origin, while the connector URL includes `/mcp`.

## Why the master-token mode is important

A normal browser cookie snapshot is not a good unattended-server credential because it expires/rotates. Current `notebooklm-py` supports a durable master-token flow that can mint fresh web session cookies without a browser on every request. This is what makes the VM genuinely unattended.

Do **not** enable the library's remote headless-browser re-authentication path. The upstream documentation explicitly distinguishes local unattended browser recovery from hosted remote MCP operation; the durable master-token flow is the appropriate server design.

## Connection to the existing Bridge

The existing `supabase/functions/notebooklm-proxy` remains available for the Bridge web application's REST integration. It is intentionally not used as the long-running MCP server.

The long-lived remote MCP endpoint is a separate service boundary:

```text
ChatGPT
  -> remote MCP /mcp
  -> notebooklm-mcp on VM
  -> NotebookLM

Bridge web app
  -> Supabase notebooklm-proxy
  -> NotebookLM service boundary (when configured)
```

Do not run two independent NotebookLM consumers against the same account/profile. The upstream project documents the account as single-consumer because concurrent session re-minting can invalidate one another.

## Security checklist

- Use a dedicated NotebookLM/Google account.
- Never commit `master_token.json`, `storage_state.json`, OAuth state, tunnel tokens, or MCP passwords.
- Never expose the container port directly to the Internet.
- Use HTTPS at the tunnel edge.
- Keep the VM single-tenant.
- Keep Docker/profile/OAuth directories owner-only.
- Do not place any NotebookLM credential in `VITE_*` variables.
- Rotate connector credentials if they are ever exposed.

## Current status

This directory defines the persistent deployment architecture. The remaining deployment-specific values are deliberately external secrets/configuration: VM credentials, the bootstrapped master token, tunnel configuration, public hostname, and OAuth password.
