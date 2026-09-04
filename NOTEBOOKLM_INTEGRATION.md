# NotebookLM Integration — Design & Implementation Status

Status: **BRIDGE IMPLEMENTED; DEPLOYMENT/NETWORK SETUP REQUIRED**

The Bridge now has an authenticated Supabase Edge Function proxy and a NotebookLM connection page that talks to a real `notebooklm-py` / `notebooklm-server` service. The remaining work is operational: the trusted machine must be authenticated, the REST service must be running, and Supabase must be able to reach it through a secure HTTPS endpoint.

## Reference implementation

Built on [teng-lin/notebooklm-py](https://github.com/teng-lin/notebooklm-py) (MIT, unofficial). It uses NotebookLM's undocumented web/RPC behavior rather than an official public consumer NotebookLM API. Google can change those endpoints without notice, so the integration must remain isolated behind this adapter.

## Current architecture

```text
User browser
   ↓ authenticated Supabase session
Bridge frontend: /notebooks/connect
   ↓ HTTPS + Supabase JWT
Supabase Edge Function: notebooklm-proxy
   ↓ server-side NOTEBOOKLM_SERVER_TOKEN
Private HTTPS endpoint / reverse proxy
   ↓
notebooklm-server on trusted machine
   ↓ local Playwright/browser session
Real NotebookLM account
```

The deployed Edge Function cannot use `localhost` or `127.0.0.1` to reach the user's Mac. The NotebookLM service therefore needs a reachable private HTTPS endpoint. See `docs/NOTEBOOKLM_SERVICE_DEPLOYMENT.md` for the exact setup.

## Authentication model

- Run `notebooklm login` on the trusted machine.
- Complete Google sign-in in the real browser window.
- Keep the resulting NotebookLM session state on that machine.
- Do not send Google passwords, cookies, or `storage_state.json` to the Bridge.
- `NOTEBOOKLM_SERVER_TOKEN` authenticates the service-to-proxy hop and is stored only as a server-side secret.

## Implemented Bridge pieces

### Supabase Edge Function

`supabase/functions/notebooklm-proxy/index.ts`:

- verifies the signed-in user's Supabase JWT;
- keeps `NOTEBOOKLM_SERVER_TOKEN` server-side;
- exposes a narrow allowlist of NotebookLM notebook/source/chat REST routes;
- provides an authenticated `/health` check mapped to the service's `/healthz`;
- forwards upstream status and response bodies without exposing the service credential.

### Connection UI

`src/routes/notebooks/connect.tsx`:

- checks the authenticated proxy health;
- clearly reports offline/configuration states;
- provides a real `/v1/notebooks` test;
- never receives the NotebookLM service bearer token;
- tells the user to authenticate/run `notebooklm-server` on the trusted machine when required.

## Remaining operational steps

1. Authenticate the trusted machine with `notebooklm login`.
2. Start `notebooklm-server` with a strong `NOTEBOOKLM_SERVER_TOKEN`.
3. Expose it through a private HTTPS/reverse-proxy boundary; never publish port 8000 directly.
4. Set Supabase secrets `NOTEBOOKLM_BASE_URL` and `NOTEBOOKLM_SERVER_TOKEN`.
5. Deploy `notebooklm-proxy`.
6. Verify health, then verify `/v1/notebooks` through the Bridge.

## Capability mapping

| Bridge operation | NotebookLM service operation |
|---|---|
| list notebooks | `GET /v1/notebooks` |
| create notebook | `POST /v1/notebooks` |
| get/update/delete notebook | `/v1/notebooks/{id}` |
| suggested prompts | `/v1/notebooks/{id}/suggested-prompts` |
| grounded chat | `POST /v1/notebooks/{id}/chat` |
| chat configuration | `POST /v1/notebooks/{id}/chat/configure` |
| URL/text/batch sources | `/v1/notebooks/{id}/sources/...` |
| source content/update/delete | `/v1/notebooks/{id}/sources/{id}...` |

The Bridge intentionally does not become a general-purpose HTTP proxy.

## Existing Nexus notebooks

The existing connector-managed `notebook.*` data is separate from the user's real NotebookLM account. There is no silent transparent migration. If migration is desired later, it should explicitly create real NotebookLM notebooks and re-add supported sources.

## Security boundary

- Never commit service tokens or Google session state.
- Never put `NOTEBOOKLM_SERVER_TOKEN` in a `VITE_*` variable.
- Never expose port 8000 directly to the public Internet.
- Keep the NotebookLM service single-tenant unless a deliberate per-user credential architecture is added.
- Treat NotebookLM cookies/storage state as live credentials.
- If the NotebookLM session expires, re-run `notebooklm login` on the trusted machine.
