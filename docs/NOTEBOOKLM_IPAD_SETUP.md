# NotebookLM iPad setup

This is the intended no-command setup for the Google Nexus Bridge.

## What changed

The Bridge now follows the same high-level master-token transaction used by `notebooklm-py`:

1. Open Google's `accounts.google.com/EmbeddedSetup` flow in a managed Browserless browser session.
2. Sign in normally in that browser from the iPad.
3. The server reads the one-time `oauth_token` from that managed session.
4. The server exchanges it with `gpsoauth` for the durable NotebookLM master credential.
5. The server verifies the credential with `notebooklm-py`.
6. The credential is stored in Supabase Vault and is never returned to the browser UI.
7. Later NotebookLM API calls mint fresh web cookies from the stored master credential.

No Mac, local Python, Terminal, VM, Docker setup, or manual master-token copying is required for the user.

## One-time dashboard configuration

### Vercel environment variables

Set these as **server-side** environment variables in the Vercel project:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (legacy) or the project's publishable-key equivalent used by the existing app
- `SUPABASE_SERVICE_ROLE_KEY` (legacy) or `SUPABASE_SECRET_KEY` if the project has migrated to Supabase's new secret-key model
- `BROWSERLESS_API_TOKEN`
- `BROWSERLESS_BASE_URL=https://production-sfo.browserless.io`

`NOTEBOOKLM_MASTER_TOKEN_JSON` is **not required** for the normal iPad flow. It remains only as a legacy fallback for an already-configured deployment.

Never create a `VITE_*` version of any server secret.

### Supabase

Apply the migrations in `supabase/migrations/` so that:

- `notebooklm_browser_sessions` stores only short-lived Browserless session metadata.
- `notebooklm_connections` stores connection metadata only.
- Supabase Vault stores the durable master-token JSON encrypted at rest.
- Only the server-side `service_role`/secret-key path can read or write the Vault credential.

The migration `20260904183000_notebooklm_master_token_vault.sql` creates the Vault RPCs used by the Vercel functions.

### Browserless

Create an API token in the Browserless dashboard and put it only in Vercel as `BROWSERLESS_API_TOKEN`.

The login flow uses a standard Browserless session. It does not enable a stealth/bot-evasion mode for Google sign-in. If Google itself rejects the managed browser, the Bridge reports that instead of attempting to bypass Google's protection.

## User flow on iPad

1. Open:
   `https://google-opus-bridge-a1e80030.vercel.app/notebooks/connect`
2. Sign in to Google Nexus if prompted.
3. Confirm the Google account email.
4. Tap **Start iPad NotebookLM login**.
5. A remote Google login browser opens.
6. Complete Google sign-in there, including any normal Google verification step.
7. Close the remote-browser tab.
8. Return to the Bridge and tap **I finished signing in — save connection**.
9. The Bridge verifies the NotebookLM credential and shows **NotebookLM connected**.

The master credential is never displayed.

## Using NotebookLM

After connection, open:

`https://google-opus-bridge-a1e80030.vercel.app/notebooklm`

The existing NotebookLM interface can list notebooks, create/delete notebooks, ask questions, list sources, add URL/text sources, and delete sources through the Vercel API.

## Testing checklist

1. `/notebooks/connect` loads without a Vercel error page.
2. **Bridge: not connected** appears before login.
3. **Start iPad NotebookLM login** returns a live browser.
4. Google login completes in the remote browser.
5. **I finished signing in — save connection** changes the status to connected.
6. `/api/notebooklm?action=health` reports `authMode: vault-master-token`.
7. `/notebooklm` can list notebooks.
8. Create a temporary notebook.
9. Add a harmless test URL or text source.
10. Ask a question about the test source.
11. Delete the test source.
12. Delete the temporary notebook.

## Security boundary

The master token is a durable, full-account Google credential. `notebooklm-py` documents it as substantially higher-risk than ordinary expiring cookies. Treat the Supabase project and its server secret as sensitive infrastructure.

The Bridge deliberately does **not**:

- display the master token;
- send the master token to the iPad;
- put the token in `VITE_*` variables;
- commit the token to GitHub;
- ask the user to paste the token into ChatGPT;
- extract credentials from the user's normal Safari/Chrome session;
- spoof a browser or bypass Google's security checks.

## Which URL?

Use the **Vercel URL** for the actual application:

- Main app: `https://google-opus-bridge-a1e80030.vercel.app`
- NotebookLM connection: `/notebooks/connect`
- NotebookLM manager: `/notebooklm`

The `.lovable.app` URL is the Lovable development/editor surface and is not the primary production URL.
