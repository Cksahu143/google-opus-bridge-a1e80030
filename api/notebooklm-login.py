import asyncio
import json
import os
import secrets
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler

import gpsoauth
import websockets

NOTEBOOKLM_EMBEDDED_SETUP = "https://accounts.google.com/EmbeddedSetup"
BROWSERLESS_DEFAULT = "https://production-sfo.browserless.io"
SESSION_TTL_MS = 600_000


def _env(*names):
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _json(handler, status, body):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.end_headers()
    handler.wfile.write(payload)


def _request_json(url, method="GET", body=None, headers=None, timeout=15):
    request = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except Exception:
            data = {"error": raw}
        return exc.code, data


def _supabase_user(jwt):
    base = _env("SUPABASE_URL", "VITE_SUPABASE_URL").rstrip("/")
    anon = _env("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY")
    if not base or not anon or not jwt:
        return None
    status, data = _request_json(
        f"{base}/auth/v1/user",
        headers={"apikey": anon, "Authorization": f"Bearer {jwt}"},
        timeout=8,
    )
    return data if status == 200 and isinstance(data, dict) and data.get("id") else None


def _service_headers():
    service = _env("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY")
    if not service:
        raise RuntimeError("Supabase server secret key is not configured.")
    return {"apikey": service, "Authorization": f"Bearer {service}"}


def _rpc(name, args):
    base = _env("SUPABASE_URL", "VITE_SUPABASE_URL").rstrip("/")
    if not base:
        raise RuntimeError("SUPABASE_URL is not configured.")
    status, data = _request_json(
        f"{base}/rest/v1/rpc/{name}",
        method="POST",
        body=args,
        headers=_service_headers(),
        timeout=10,
    )
    if status < 200 or status >= 300:
        message = data.get("message") or data.get("hint") or data.get("error") or f"RPC failed ({status})"
        raise RuntimeError(str(message))
    return data


def _session_row(user_id):
    base = _env("SUPABASE_URL", "VITE_SUPABASE_URL").rstrip("/")
    query = urllib.parse.urlencode({"user_id": f"eq.{user_id}", "provider": "eq.browserless", "select": "*", "limit": "1"})
    status, data = _request_json(
        f"{base}/rest/v1/notebooklm_browser_sessions?{query}",
        headers=_service_headers(),
        timeout=8,
    )
    if status != 200 or not isinstance(data, list) or not data:
        return None
    return data[0]


def _upsert_session(user_id, session_id, live_url, stop_url, expires_at):
    base = _env("SUPABASE_URL", "VITE_SUPABASE_URL").rstrip("/")
    request = urllib.request.Request(
        f"{base}/rest/v1/notebooklm_browser_sessions",
        method="POST",
        data=json.dumps({
            "user_id": user_id,
            "provider": "browserless",
            "provider_session_id": session_id,
            "browserql_url": live_url,
            "stop_url": stop_url,
            "expires_at": expires_at,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
            **_service_headers(),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            if response.status not in (200, 201, 204):
                raise RuntimeError(f"Could not persist browser session ({response.status}).")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Could not persist browser session ({exc.code}).") from exc


def _browserless():
    origin = _env("BROWSERLESS_BASE_URL") or BROWSERLESS_DEFAULT
    token = _env("BROWSERLESS_API_TOKEN", "BROWSERLESS_API_KEY", "BROWSERLESS_TOKEN")
    if not token:
        raise RuntimeError("Browserless API token is not configured.")
    return origin.rstrip("/"), token


async def _cdp_call(ws_url, method, params=None, session_id=None, timeout=20):
    next_id = 1
    async with websockets.connect(f"{ws_url}&timeout=45000", open_timeout=15, close_timeout=5, max_size=8 * 1024 * 1024) as socket:
        message = {"id": next_id, "method": method}
        if params is not None:
            message["params"] = params
        if session_id:
            message["sessionId"] = session_id
        await socket.send(json.dumps(message))
        while True:
            raw = await asyncio.wait_for(socket.recv(), timeout=timeout)
            response = json.loads(raw)
            if response.get("id") != next_id:
                continue
            if "error" in response:
                raise RuntimeError(response["error"].get("message") or "Browser session command failed.")
            return response.get("result") or {}


async def _create_live_url(ws_url):
    targets = await _cdp_call(ws_url, "Target.getTargets")
    page = next((target for target in targets.get("targetInfos", []) if target.get("type") == "page"), None)
    if not page:
        raise RuntimeError("Browserless did not expose a login page target.")
    attached = await _cdp_call(ws_url, "Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})
    session_id = attached.get("sessionId")
    if not session_id:
        raise RuntimeError("Could not attach to the Browserless login page.")
    result = await _cdp_call(
        ws_url,
        "Browserless.liveURL",
        {
            "timeout": 540000,
            "interactable": True,
            "resizable": True,
            "showBrowserInterface": False,
            "emulateComponents": True,
        },
        session_id=session_id,
    )
    live_url = result.get("liveURL")
    if not live_url:
        raise RuntimeError(result.get("error") or "Browserless did not return a live login URL.")
    return live_url


def _start_browserless(user_id):
    origin, token = _browserless()
    status, session = _request_json(
        f"{origin}/session?token={urllib.parse.quote(token)}",
        method="POST",
        body={"ttl": SESSION_TTL_MS, "headless": True, "url": NOTEBOOKLM_EMBEDDED_SETUP},
        timeout=15,
    )
    if status < 200 or status >= 300 or not session.get("id") or not session.get("connect") or not session.get("stop"):
        message = session.get("message") or session.get("error") or f"Browserless session creation failed ({status})."
        raise RuntimeError(str(message))

    try:
        live_url = asyncio.run(_create_live_url(session["connect"]))
    except Exception:
        try:
            urllib.request.urlopen(urllib.request.Request(session["stop"], method="DELETE"), timeout=8).close()
        except Exception:
            pass
        raise

    expires_at = (datetime.now(timezone.utc) + timedelta(milliseconds=SESSION_TTL_MS)).isoformat()
    _upsert_session(user_id, session["id"], live_url, session["stop"], expires_at)
    return {"provider": "browserless", "sessionId": session["id"], "liveUrl": live_url, "expiresAt": expires_at}


def _browserless_ws(session_id):
    origin, token = _browserless()
    parsed = urllib.parse.urlsplit(origin)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    host = parsed.netloc
    return f"{scheme}://{host}/session/connect/{urllib.parse.quote(session_id)}?token={urllib.parse.quote(token)}"


async def _cdp_get_all_cookies(ws_url):
    return (await _cdp_call(ws_url, "Network.getAllCookies")).get("cookies") or []


def _stop_browserless(session):
    if not session or not session.get("stop_url"):
        return
    try:
        urllib.request.urlopen(urllib.request.Request(session["stop_url"], method="DELETE"), timeout=8).close()
    except Exception:
        pass


def _exchange_master_token(email, oauth_token):
    android_id = secrets.token_hex(8)
    response = gpsoauth.exchange_token(email, oauth_token, android_id)
    master = response.get("Token") if isinstance(response, dict) else None
    if not master:
        error = response.get("Error") if isinstance(response, dict) else None
        raise RuntimeError(f"Google master-token exchange failed{f': {error}' if error else '.'}")
    return {"version": 1, "email": email, "android_id": android_id, "master_token": master}


def _verify_master_token(token_json):
    with tempfile.TemporaryDirectory(prefix="notebooklm-master-verify-") as tmp:
        profile = tempfile.TemporaryDirectory(prefix="notebooklm-profile-")
        try:
            profile_dir = profile.name
            token_path = os.path.join(profile_dir, "master_token.json")
            with open(token_path, "w", encoding="utf-8") as handle:
                json.dump(token_json, handle, separators=(",", ":"))
            os.chmod(token_path, 0o600)
            storage = os.path.join(profile_dir, "storage_state.json")
            command = ["notebooklm", "--storage", storage, "auth", "refresh", "--verify"]
            completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=25, check=False, env={**os.environ, "NO_COLOR": "1"})
            if completed.returncode != 0:
                message = completed.stderr.strip() or completed.stdout.strip() or "NotebookLM authentication verification failed"
                raise RuntimeError(message[-2000:])
        finally:
            profile.cleanup()


def _complete(user_id, email):
    session = _session_row(user_id)
    if not session:
        raise RuntimeError("No active iPad login session was found. Start the login again.")
    if session.get("provider") != "browserless":
        raise RuntimeError("The active login session is not a Browserless session.")

    try:
        cookies = asyncio.run(_cdp_get_all_cookies(_browserless_ws(session["provider_session_id"])))
        oauth_cookie = next((cookie for cookie in cookies if cookie.get("name") == "oauth_token"), None)
        if not oauth_cookie or not oauth_cookie.get("value"):
            raise RuntimeError("Google has not completed the EmbeddedSetup login yet. Finish the Google sign-in in the remote browser, close the remote-browser tab, then press Finish again.")

        token_json = _exchange_master_token(email, oauth_cookie["value"])
        _verify_master_token(token_json)
        secret_name = _rpc("vault_upsert_notebooklm_master_token", {"p_user_id": user_id, "p_secret": json.dumps(token_json, separators=(",", ":"))})
        return {"ok": True, "connected": True, "authMode": "vault-master-token", "email": email, "secretStored": True, "secretName": secret_name}
    finally:
        _stop_browserless(session)
        base = _env("SUPABASE_URL", "VITE_SUPABASE_URL").rstrip("/")
        query = urllib.parse.urlencode({"user_id": f"eq.{user_id}", "provider": "eq.browserless"})
        try:
            request = urllib.request.Request(f"{base}/rest/v1/notebooklm_browser_sessions?{query}", method="DELETE", headers=_service_headers())
            urllib.request.urlopen(request, timeout=8).close()
        except Exception:
            pass


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        _json(self, 204, {})

    def _auth(self):
        header = self.headers.get("Authorization", "")
        if not header.lower().startswith("bearer "):
            raise PermissionError("Missing Supabase authorization.")
        user = _supabase_user(header[7:].strip())
        if not user:
            raise PermissionError("Invalid or expired Supabase session.")
        return user

    def do_GET(self):
        try:
            user = self._auth()
            status = _rpc("vault_notebooklm_connection_status", {"p_user_id": user["id"]})
            _json(self, 200, {"ok": True, "connected": bool(status), "connection": status or None})
        except PermissionError as exc:
            _json(self, 401, {"ok": False, "error": str(exc)})
        except Exception as exc:
            _json(self, 502, {"ok": False, "error": str(exc)})

    def do_POST(self):
        try:
            user = self._auth()
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            action = str(body.get("action", "")).strip()
            if action == "start":
                email = str(body.get("email", "") or user.get("email", "")).strip()
                if not email or "@" not in email:
                    raise ValueError("A Google account email is required for the master-token bootstrap.")
                _json(self, 200, {"ok": True, "data": _start_browserless(user["id"])})
                return
            if action == "complete":
                email = str(body.get("email", "") or user.get("email", "")).strip()
                if not email or "@" not in email:
                    raise ValueError("A Google account email is required for the master-token bootstrap.")
                _json(self, 200, {"ok": True, "data": _complete(user["id"], email)})
                return
            if action == "disconnect":
                _rpc("vault_disconnect_notebooklm", {"p_user_id": user["id"]})
                _json(self, 200, {"ok": True, "disconnected": True})
                return
            raise ValueError("Unsupported action. Use start, complete, or disconnect.")
        except PermissionError as exc:
            _json(self, 401, {"ok": False, "error": str(exc)})
        except ValueError as exc:
            _json(self, 400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            _json(self, 502, {"ok": False, "error": str(exc)})

    def log_message(self, format, *args):
        return
