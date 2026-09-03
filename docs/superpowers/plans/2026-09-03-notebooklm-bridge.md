# NotebookLM Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Google Nexus to the user's real consumer NotebookLM session through the authenticated local `notebooklm-py` service without exposing Google session state or service credentials to the browser.

**Architecture:** The browser authenticates to Supabase, then calls an authenticated `notebooklm-proxy` Edge Function. The Edge Function forwards a narrow allowlist of NotebookLM REST operations to a network-reachable HTTPS endpoint backed by `notebooklm-server`; Google authentication and `storage_state.json` remain on the trusted machine.

**Tech Stack:** React 19, TanStack Start/Router, Supabase Edge Functions (Deno), Supabase Auth, notebooklm-py REST server, HTTPS reverse proxy/tunnel.

**Spec:** `NOTEBOOKLM_INTEGRATION.md` plus the approved bridge architecture from the implementation discussion.

## Global Constraints

- Do not rename the repository `google-opus-bridge-a1e80030`.
- Do not expose Google passwords, browser cookies, `storage_state.json`, or NotebookLM service tokens to the browser or GitHub.
- Do not use Steel to perform Google OAuth for NotebookLM.
- The Edge Function must remain an allowlisted proxy, not a generic URL forwarder.
- `notebooklm-server` remains single-tenant and keeps authenticated browser state on the trusted machine.
- A deployed Edge Function cannot reach the Mac's `127.0.0.1`; production requires a secure network-reachable HTTPS endpoint.
- Preserve existing Steel functionality for unrelated integrations.

---

### Task 1: Proxy contract and authentication

**Files:**
- Create: `supabase/functions/notebooklm-proxy/index.ts`
- Modify: `supabase/config.toml`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Supabase Auth bearer JWT from the browser; `NOTEBOOKLM_BASE_URL`; `NOTEBOOKLM_SERVER_TOKEN`.
- Produces: authenticated `/health` plus allowlisted `/v1/*` NotebookLM REST operations.

- [ ] **Step 1: Write failing tests for auth and allowlisting**

Create focused tests for the proxy contract: missing/invalid JWT returns 401, disallowed paths return 404, disallowed methods return 405, and valid requests forward only the service bearer token.

- [ ] **Step 2: Run the tests and confirm the expected failures**

Run the repository's available test runner against the new proxy tests. The tests must fail because the contract is not yet implemented in the isolated implementation branch.

- [ ] **Step 3: Implement the minimal proxy**

Use Supabase Auth `getUser`, read service configuration from `Deno.env`, and forward only notebook, source, prompt, and chat routes. Never forward arbitrary client headers or client-provided upstream URLs.

- [ ] **Step 4: Run the focused tests again**

Confirm the proxy contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/notebooklm-proxy/index.ts supabase/config.toml .env.example
git commit -m "feat: add authenticated NotebookLM service proxy"
```

---

### Task 2: NotebookLM connection UI

**Files:**
- Modify: `src/routes/notebooks/connect.tsx`

**Interfaces:**
- Consumes: `/notebooklm-proxy/health` and `/notebooklm-proxy/v1/notebooks`.
- Produces: clear service-connected/offline states and real-notebook verification without exposing service credentials.

- [ ] **Step 1: Write failing UI tests**

Test that the connection screen calls the proxy health endpoint, reports an offline state on non-2xx responses, and renders returned notebook data only after a successful authenticated request.

- [ ] **Step 2: Run UI tests and confirm failure**

Run the focused UI test command and verify it fails for the missing expected behavior.

- [ ] **Step 3: Implement the smallest UI integration**

Use the existing Supabase session access, call the proxy endpoints, and keep Google login instructions local to the trusted machine. Do not add a browser-side NotebookLM token.

- [ ] **Step 4: Run UI tests and confirm green**

Confirm the focused UI tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/notebooks/connect.tsx
git commit -m "feat: connect NotebookLM UI to service proxy"
```

---

### Task 3: Secure service exposure

**Files:**
- Create: `docs/NOTEBOOKLM_SERVICE_DEPLOYMENT.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: local `notebooklm-server` on `127.0.0.1:8000`.
- Produces: a documented HTTPS endpoint for `NOTEBOOKLM_BASE_URL` and a server-side `NOTEBOOKLM_SERVER_TOKEN` configuration.

- [ ] **Step 1: Document the local service contract**

Document `/healthz`, `/v1/notebooks`, bearer authentication, loopback binding, and the requirement that `storage_state.json` stays on the trusted machine.

- [ ] **Step 2: Document secure tunnel routing**

Document a production tunnel mapping from a private HTTPS hostname to `http://127.0.0.1:8000`. Explicitly prohibit direct exposure of port 8000 and prohibit putting the server token in frontend environment variables.

- [ ] **Step 3: Document secret configuration**

Document setting `NOTEBOOKLM_BASE_URL` and `NOTEBOOKLM_SERVER_TOKEN` as Supabase Edge Function secrets rather than committing them.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/NOTEBOOKLM_SERVICE_DEPLOYMENT.md .env.example
git commit -m "docs: document secure NotebookLM service exposure"
```

---

### Task 4: Verification and live integration

**Files:**
- Modify only if verification exposes a concrete defect.

**Interfaces:**
- Consumes: deployed Edge Function, configured HTTPS service endpoint, authenticated user session.
- Produces: verified health response and verified real-notebook listing.

- [ ] **Step 1: Deploy the Edge Function**

Use the Supabase CLI or Dashboard to deploy `notebooklm-proxy`; Supabase documents both paths and the resulting function URL.

- [ ] **Step 2: Configure production secrets**

Set `NOTEBOOKLM_BASE_URL` and `NOTEBOOKLM_SERVER_TOKEN` in Supabase Edge Function secrets. Never paste the secret into GitHub or the frontend.

- [ ] **Step 3: Verify service health**

Invoke the authenticated proxy `/health` endpoint and confirm the response reports the upstream service as healthy.

- [ ] **Step 4: Verify real NotebookLM data**

Invoke `/v1/notebooks` through the proxy and confirm the returned notebooks belong to the authenticated local NotebookLM session.

- [ ] **Step 5: Run repository verification**

Run the project's lint and production build commands and inspect the Git diff for accidental secret exposure.

- [ ] **Step 6: Commit only verified fixes**

Commit any concrete defects found during verification with a focused message; do not claim end-to-end completion until the live health and notebook-list checks succeed.
