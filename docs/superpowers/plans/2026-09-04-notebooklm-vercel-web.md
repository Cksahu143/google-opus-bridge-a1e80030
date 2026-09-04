# NotebookLM Vercel Web Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser-provider login path with a Vercel-hosted web API that embeds the maintained `notebooklm-py` client and exposes NotebookLM operations to the existing React app.

**Architecture:** Keep the existing Vite/Lovable frontend and add a Vercel Python serverless API under `api/`. The API uses `notebooklm-py[headless]` and a server-side master-token profile to mint/refresh NotebookLM web cookies and execute NotebookLM operations. The browser never receives Google credentials; the existing browser automation gateway remains available as a legacy path but is no longer the primary integration.

**Tech Stack:** React/Vite, Vercel Python Functions, Python 3.12+, `notebooklm-py[headless]`, Supabase JWT verification, HTTP/JSON.

**Spec:** `docs/superpowers/plans/2026-09-04-notebooklm-vercel-web.md`

## Global Constraints

- Never expose or commit Google master tokens, cookies, OAuth tokens, or `.env` contents.
- Keep the repository name `google-opus-bridge-a1e80030` unchanged.
- Use the maintained `teng-lin/notebooklm-py` package rather than copying its private protocol implementation.
- Vercel is the web deployment target; no VM, Mac daemon, or external browser service is required for runtime.
- Treat the `notebooklm-py` REST/server surface as experimental and pin the dependency version before production use.
- The Vercel function is single-tenant unless explicit multi-tenant credential storage is added later.

---

### Task 1: Add the Python runtime dependency and server entry point

**Files:**
- Create: `api/notebooklm/index.py`
- Create: `requirements.txt`
- Create: `vercel.json`

**Interfaces:**
- Consumes: `NOTEBOOKLM_MASTER_TOKEN_JSON` or a server-side profile directory and Supabase auth environment variables.
- Produces: `GET /api/notebooklm?action=health`, `GET /api/notebooklm?action=list`, and `POST /api/notebooklm` for supported operations.

- [ ] **Step 1: Write the dependency manifest**

Pin the maintained package with the headless extra, using a version selected from the current upstream release before deployment.

- [ ] **Step 2: Implement request authentication**

Verify the incoming Supabase JWT server-side and reject unauthenticated requests before touching NotebookLM credentials.

- [ ] **Step 3: Implement the NotebookLM client factory**

Create a short-lived profile under `/tmp`, materialize the server-side master-token JSON only in memory-backed temporary storage, run the upstream auth refresh transaction, and construct `NotebookLMClient` from the resulting storage state. Never return the token or cookies in JSON.

- [ ] **Step 4: Implement the minimal operation router**

Support notebook list/get/create/delete, source list/add/delete, and notebook chat using the public `notebooklm-py` client API. Return JSON-serializable results only.

- [ ] **Step 5: Configure Vercel**

Route `/api/notebooklm` to the Python function and leave the existing frontend build behavior unchanged.

- [ ] **Step 6: Commit**

Commit message: `feat: add vercel notebooklm python bridge`

---

### Task 2: Add the web client adapter

**Files:**
- Create or modify: `src/lib/notebooklm-web.ts`
- Modify: `src/routes/notebooks/index.tsx`
- Modify: `src/routes/notebooks/$notebookId.tsx`

**Interfaces:**
- Consumes: `/api/notebooklm` JSON API.
- Produces: typed notebook/source/chat operations for the UI.

- [ ] **Step 1: Add typed API helpers**

Implement `notebookList`, `notebookGet`, `notebookCreate`, `notebookDelete`, `sourceList`, `sourceAdd`, `sourceDelete`, and `notebookAsk`.

- [ ] **Step 2: Replace browser-session assumptions**

Make the notebook pages prefer the direct Vercel bridge and only show the old browser-login UI as a legacy fallback/status path.

- [ ] **Step 3: Add clear connection state**

Display `Connected`, `Needs server configuration`, and `NotebookLM request failed` states without exposing server-side credential details.

- [ ] **Step 4: Commit**

Commit message: `feat: use vercel notebooklm bridge in web ui`

---

### Task 3: Document deployment and authentication boundary

**Files:**
- Modify: `NOTEBOOKLM_INTEGRATION.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Vercel environment configuration.
- Produces: deployment documentation explaining the one-time master-token bootstrap boundary and server-only secret handling.

- [ ] **Step 1: Document Vercel deployment**

Explain the Python function, dependency pin, required server-side variables, and Supabase authentication boundary.

- [ ] **Step 2: Document the irreducible bootstrap**

State clearly that `notebooklm-py` requires a one-time browser authentication to obtain its durable master token; the web app cannot manufacture that credential from a normal Google OAuth session.

- [ ] **Step 3: Commit**

Commit message: `docs: document vercel notebooklm deployment`

---

### Verification

- [ ] Re-read every changed file from GitHub after commits.
- [ ] Confirm no secret-bearing file was modified or committed.
- [ ] Confirm the Python entry point imports only documented `notebooklm-py` APIs.
- [ ] Confirm the frontend calls the new API route and does not send Google credentials.
- [ ] Confirm Vercel configuration does not replace the existing frontend build.
- [ ] Report that runtime deployment still requires Vercel environment configuration if it cannot be verified from repository evidence.
