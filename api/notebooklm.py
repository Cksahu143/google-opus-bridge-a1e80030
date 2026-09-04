import json
import os
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler


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


def _env(*names):
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _request_json(url, method="GET", body=None, headers=None, timeout=10):
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


def _supabase_user(token):
    """Validate the user's Supabase JWT without exposing service credentials."""
    base = _env("SUPABASE_URL", "VITE_SUPABASE_URL").rstrip("/")
    anon = _env("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY")
    if not base or not anon or not token:
        return None
    status, data = _request_json(
        f"{base}/auth/v1/user",
        headers={"apikey": anon, "Authorization": f"Bearer {token}"},
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


def _master_token(user_id):
    """Load a per-user master-token JSON object from Supabase Vault.

    The legacy environment variable remains a compatibility fallback, but a
    normal iPad login stores the credential in Vault and never requires the
    user to paste it into Vercel.
    """
    try:
        value = _rpc("vault_read_notebooklm_master_token", {"p_user_id": user_id})
        if isinstance(value, str) and value.strip():
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
    except Exception:
        # Preserve the legacy env-var path for existing deployments while the
        # Vault migration is being rolled out.
        pass

    value = _env("NOTEBOOKLM_MASTER_TOKEN_JSON")
    if not value:
        raise RuntimeError("NotebookLM is not connected yet. Use the iPad login flow first.")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise RuntimeError("NOTEBOOKLM_MASTER_TOKEN_JSON is not valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("NOTEBOOKLM_MASTER_TOKEN_JSON must contain a JSON object.")
    return parsed


def _run_nlm(args, profile_dir, timeout=50):
    storage = str(Path(profile_dir) / "storage_state.json")
    command = ["notebooklm", "--storage", storage, *args]
    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
        text=True,
        env={**os.environ, "NO_COLOR": "1"},
    )
    stdout = completed.stdout
    stderr = completed.stderr
    if completed.returncode != 0:
        message = stderr.strip() or stdout.strip() or f"notebooklm exited with {completed.returncode}"
        raise RuntimeError(message[-4000:])
    if stdout.strip():
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            return {"output": stdout.strip()}
    return {"ok": True}


def _with_profile(user_id, callback):
    token = _master_token(user_id)
    with tempfile.TemporaryDirectory(prefix="notebooklm-") as tmp:
        profile = Path(tmp)
        token_path = profile / "master_token.json"
        token_path.write_text(json.dumps(token, separators=(",", ":")), encoding="utf-8")
        os.chmod(token_path, 0o600)
        _run_nlm(["auth", "refresh", "--verify"], profile, timeout=25)
        return callback(profile)


def _require_auth(handler):
    header = handler.headers.get("Authorization", "")
    if not header.lower().startswith("bearer "):
        raise PermissionError("Missing Supabase authorization.")
    user = _supabase_user(header[7:].strip())
    if not user:
        raise PermissionError("Invalid or expired Supabase session.")
    return user


def _query(handler):
    return {key: values[-1] for key, values in urllib.parse.parse_qs(handler.path.partition("?")[2]).items()}


def _body(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length) if length else b"{}"
    return json.loads(raw.decode("utf-8"))


def _execute(action, data, profile):
    notebook_id = data.get("notebookId", "")
    source_id = data.get("sourceId", "")

    if action == "list":
        return _run_nlm(["list", "notebooks", "--json"], profile)
    if action == "get":
        return _run_nlm(["get", "notebook", notebook_id, "--json"], profile)
    if action == "create":
        return _run_nlm(["create", "notebook", data["title"], "--json"], profile)
    if action == "delete":
        return _run_nlm(["delete", "notebook", notebook_id, "--confirm"], profile)
    if action == "ask":
        return _run_nlm(["query", "notebook", notebook_id, data["question"], "--json"], profile, timeout=55)
    if action == "sources":
        return _run_nlm(["list", "sources", notebook_id, "--full", "--json"], profile)
    if action == "add-url":
        args = ["source", "add", notebook_id, "--url", data["url"]]
        if data.get("wait"):
            args.append("--wait")
        return _run_nlm(args, profile, timeout=55)
    if action == "add-text":
        args = ["source", "add", notebook_id, "--text", data["text"], "--title", data.get("title", "Web note")]
        if data.get("wait"):
            args.append("--wait")
        return _run_nlm(args, profile, timeout=55)
    if action == "delete-source":
        return _run_nlm(["source", "delete", source_id, "--confirm"], profile)
    raise ValueError(f"Unsupported NotebookLM action: {action}")


def _health(user_id):
    try:
        status = _rpc("vault_notebooklm_connection_status", {"p_user_id": user_id})
        if status and isinstance(status, dict) and status.get("status") == "connected":
            return {"ok": True, "configured": True, "provider": "notebooklm-py", "authMode": "vault-master-token", "officialLoginDoesNotTransferSession": False}
    except Exception:
        pass
    configured = bool(_env("NOTEBOOKLM_MASTER_TOKEN_JSON"))
    return {"ok": True, "configured": configured, "provider": "notebooklm-py", "authMode": "server-master-token" if configured else "not-configured", "officialLoginDoesNotTransferSession": True}


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        _json(self, 204, {})

    def do_GET(self):
        try:
            user = _require_auth(self)
            params = _query(self)
            action = params.get("action", "health")
            if action == "health":
                _json(self, 200, _health(user["id"]))
                return
            result = _with_profile(user["id"], lambda profile: _execute(action, params, profile))
            _json(self, 200, {"ok": True, "data": result})
        except PermissionError as exc:
            _json(self, 401, {"ok": False, "error": str(exc)})
        except Exception as exc:
            _json(self, 502, {"ok": False, "error": str(exc)})

    def do_POST(self):
        try:
            user = _require_auth(self)
            data = _body(self)
            action = str(data.pop("action", "")).strip()
            if not action:
                raise ValueError("Missing action.")
            if action == "health":
                _json(self, 200, _health(user["id"]))
                return
            result = _with_profile(user["id"], lambda profile: _execute(action, data, profile))
            _json(self, 200, {"ok": True, "data": result})
        except PermissionError as exc:
            _json(self, 401, {"ok": False, "error": str(exc)})
        except KeyError as exc:
            _json(self, 400, {"ok": False, "error": f"Missing field: {exc.args[0]}"})
        except Exception as exc:
            _json(self, 502, {"ok": False, "error": str(exc)})

    def log_message(self, format, *args):
        return
