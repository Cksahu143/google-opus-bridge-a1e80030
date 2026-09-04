import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qs
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


def _supabase_user(token):
    """Validate the user's Supabase JWT without exposing service-role credentials."""
    import urllib.request

    base = _env("SUPABASE_URL", "VITE_SUPABASE_URL").rstrip("/")
    anon = _env("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY")
    if not base or not anon or not token:
        return None
    request = urllib.request.Request(
        f"{base}/auth/v1/user",
        headers={"apikey": anon, "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


def _master_token():
    value = _env("NOTEBOOKLM_MASTER_TOKEN_JSON")
    if not value:
        raise RuntimeError("NotebookLM server authentication is not configured.")
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


def _with_profile(callback):
    token = _master_token()
    with tempfile.TemporaryDirectory(prefix="notebooklm-") as tmp:
        profile = Path(tmp)
        (profile / "master_token.json").write_text(json.dumps(token), encoding="utf-8")
        os.chmod(profile / "master_token.json", 0o600)
        _run_nlm(["auth", "refresh", "--verify"], profile, timeout=20)
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
    return {key: values[-1] for key, values in parse_qs(handler.path.partition("?")[2]).items()}


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


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        _json(self, 204, {})

    def do_GET(self):
        try:
            _require_auth(self)
            params = _query(self)
            action = params.get("action", "health")
            if action == "health":
                configured = bool(_env("NOTEBOOKLM_MASTER_TOKEN_JSON"))
                _json(self, 200, {
                    "ok": True,
                    "configured": configured,
                    "provider": "notebooklm-py",
                    "authMode": "server-master-token" if configured else "not-configured",
                    "officialLoginDoesNotTransferSession": True,
                })
                return
            result = _with_profile(lambda profile: _execute(action, params, profile))
            _json(self, 200, {"ok": True, "data": result})
        except PermissionError as exc:
            _json(self, 401, {"ok": False, "error": str(exc)})
        except Exception as exc:
            _json(self, 502, {"ok": False, "error": str(exc)})

    def do_POST(self):
        try:
            _require_auth(self)
            data = _body(self)
            action = str(data.pop("action", "")).strip()
            if not action:
                raise ValueError("Missing action.")
            if action == "health":
                configured = bool(_env("NOTEBOOKLM_MASTER_TOKEN_JSON"))
                _json(self, 200, {
                    "ok": True,
                    "configured": configured,
                    "provider": "notebooklm-py",
                    "authMode": "server-master-token" if configured else "not-configured",
                    "officialLoginDoesNotTransferSession": True,
                })
                return
            result = _with_profile(lambda profile: _execute(action, data, profile))
            _json(self, 200, {"ok": True, "data": result})
        except PermissionError as exc:
            _json(self, 401, {"ok": False, "error": str(exc)})
        except KeyError as exc:
            _json(self, 400, {"ok": False, "error": f"Missing field: {exc.args[0]}"})
        except Exception as exc:
            _json(self, 502, {"ok": False, "error": str(exc)})

    def log_message(self, format, *args):
        return
