# NotebookLM Google Authentication

## Why the cloud browser login fails

The Bridge's Browserless/Browserbase/Steel/Cloudflare sessions are remote automation browsers. They are useful for ordinary browser automation, but they are not a reliable place to perform Google Account OAuth sign-in.

Google's OAuth policy requires authorization requests to use secure browser contexts and documents `disallowed_useragent` when an authorization endpoint is opened inside a disallowed embedded user-agent. A remote browser viewer does not change that policy.

Therefore **do not use the cloud-browser gateway as the Google/NotebookLM authentication bootstrap**.

## Supported architecture

1. On a normal browser machine (for example the Mac), perform the one-time NotebookLM authentication bootstrap.
2. Use `notebooklm-py` master-token authentication for the durable server credential.
3. Move the resulting profile to the persistent Linux VM using a secure file-transfer method.
4. Run the maintained `notebooklm-mcp` deployment on the VM.
5. Expose only the MCP endpoint through an HTTPS tunnel.
6. Let the Bridge and remote MCP clients use the authenticated service rather than attempting Google sign-in inside a cloud browser.

The upstream deployment documents the exact bootstrap command and persistent Docker deployment: `notebooklm login --master-token` on the browser workstation, followed by the remote Docker/Compose deployment.

## One-time bootstrap

On the browser workstation:

```bash
pip install "notebooklm-py[browser,headless]"
notebooklm login --master-token --account YOUR_DEDICATED_NOTEBOOKLM_ACCOUNT
```

The profile contains `master_token.json`. Treat it as a full-account credential. Never commit it, paste it into chat, put it in `VITE_*`, or expose it through the browser gateway.

## What remains in the Bridge

The browser gateway remains available for provider experiments and ordinary browser automation. It is **not** the Google OAuth mechanism.

The persistent service deployment is documented in:

- `deploy/notebooklm-mcp/README.md`
- `NOTEBOOKLM_INTEGRATION.md`

The existing `notebooklm-proxy` remains the authenticated application REST boundary when `NOTEBOOKLM_BASE_URL` and `NOTEBOOKLM_SERVER_TOKEN` point at a compatible NotebookLM service.
