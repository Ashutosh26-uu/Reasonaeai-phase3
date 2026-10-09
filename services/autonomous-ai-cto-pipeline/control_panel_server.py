"""
Local control panel server.

Serves control_panel.html and exposes three endpoints:

  POST /transcribe  - receive an audio blob, run it through M01, return the text
  POST /build       - receive confirmed/edited text, run the full pipeline
                       (M02 -> M03 -> M06 -> Docker) in a background thread
  GET  /status       - poll build progress and the final result

Run with:
    python control_panel_server.py
Then open http://localhost:9000 in a browser.
"""

import json
import re
import tempfile
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import panel_store
from panel_store import AuthError
from run_pipeline import PIPELINE_STEPS, run_pipeline_core

ROOT = Path(__file__).resolve().parent
HTML_PATH = ROOT / "control_panel.html"

# In-memory build status, keyed by a build id the browser holds onto.
_builds: dict[str, dict] = {}
_builds_lock = threading.Lock()


def _set_status(build_id: str, **fields) -> None:
    with _builds_lock:
        _builds.setdefault(build_id, {})
        _builds[build_id].update(fields)


def _run_build_in_background(build_id: str, idea_text: str, resume_project: str | None = None) -> None:
    project_name = resume_project or f"webdemo_{build_id[:8]}"
    _set_status(
        build_id, state="running", log="Starting pipeline...",
        steps=PIPELINE_STEPS, current=-1, project=project_name,
    )

    def on_step(index: int, label: str) -> None:
        _set_status(build_id, current=index, log=label + "...")

    try:
        result = run_pipeline_core(
            idea_text=idea_text,
            project_name=project_name,
            resume_project=resume_project,
            backend_port=9100,
            frontend_port=9200,
            on_step=on_step,
        )
        if result["success"]:
            _set_status(build_id, state="done", result=result)
            panel_store.finish_build(build_id, "done", result=result)
        else:
            message = result.get("error", "Unknown failure.")
            _set_status(build_id, state="error", error=message)
            panel_store.finish_build(build_id, "error", error=message)
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        _set_status(build_id, state="error", error=message)
        panel_store.finish_build(build_id, "error", error=message)
        traceback.print_exc()


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _token(self) -> str | None:
        header = self.headers.get("Authorization", "")
        return header[7:].strip() if header.startswith("Bearer ") else None

    def _user(self) -> dict | None:
        return panel_store.user_for_token(self._token())

    def do_GET(self) -> None:
        if self.path == "/api/me":
            user = self._user()
            self._send_json({"user": user} if user else {"error": "Not logged in."}, 200 if user else 401)
            return

        if self.path == "/api/history":
            user = self._user()
            if not user:
                self._send_json({"error": "Please log in."}, 401)
                return
            self._send_json({"builds": panel_store.list_builds(user["id"])})
            return

        if self.path == "/" or self.path == "/control_panel.html":
            html = HTML_PATH.read_text(encoding="utf-8")
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path.startswith("/status"):
            build_id = self.path.split("build_id=")[-1] if "build_id=" in self.path else ""
            with _builds_lock:
                status = _builds.get(build_id, {"state": "unknown"})
            self._send_json(status)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length)

        if self.path == "/transcribe":
            try:
                with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
                    tmp.write(raw_body)
                    tmp_path = tmp.name

                from modules.m01_sensory.service import normalize_audio
                result = normalize_audio(tmp_path)
                self._send_json({"text": result.text})
            except Exception as exc:
                traceback.print_exc()
                self._send_json({"error": f"{type(exc).__name__}: {exc}"}, status=500)
            return

        if self.path in ("/api/signup", "/api/login", "/api/logout"):
            try:
                payload = json.loads(raw_body.decode("utf-8") or "{}")
                if self.path == "/api/logout":
                    panel_store.logout(self._token())
                    self._send_json({"ok": True})
                elif self.path == "/api/signup":
                    self._send_json(panel_store.signup(payload.get("name"), payload.get("email"), payload.get("password")))
                else:
                    self._send_json(panel_store.login(payload.get("email"), payload.get("password")))
            except AuthError as exc:
                self._send_json({"error": str(exc)}, status=400)
            except Exception as exc:
                traceback.print_exc()
                self._send_json({"error": f"{type(exc).__name__}: {exc}"}, status=500)
            return

        if self.path == "/build":
            user = self._user()
            if not user:
                self._send_json({"error": "Please log in to build an app."}, status=401)
                return
            try:
                payload = json.loads(raw_body.decode("utf-8"))
                idea_text = payload["text"].strip()
                if not idea_text:
                    self._send_json({"error": "Empty text."}, status=400)
                    return

                # "Try again" sends the folder of the failed run so finished work is reused.
                resume_project = payload.get("resume_project") or None
                if resume_project and not (
                    re.fullmatch(r"[A-Za-z0-9_\-]+", resume_project)
                    and (ROOT / "pipeline_runs" / resume_project).is_dir()
                    and panel_store.can_use_project(user["id"], resume_project)
                ):
                    resume_project = None

                build_id = uuid.uuid4().hex
                _set_status(build_id, state="queued")
                panel_store.add_build(build_id, user["id"], idea_text, resume_project or f"webdemo_{build_id[:8]}")
                thread = threading.Thread(
                    target=_run_build_in_background,
                    args=(build_id, idea_text, resume_project),
                    daemon=True,
                )
                thread.start()
                self._send_json({"build_id": build_id})
            except Exception as exc:
                traceback.print_exc()
                self._send_json({"error": f"{type(exc).__name__}: {exc}"}, status=500)
            return

        self.send_response(404)
        self.end_headers()

    def do_DELETE(self) -> None:
        user = self._user()
        if not user:
            self._send_json({"error": "Please log in."}, 401)
            return
        if self.path.startswith("/api/history/"):
            build_id = self.path.rsplit("/", 1)[-1]
            ok = re.fullmatch(r"[0-9a-f]{32}", build_id) and panel_store.delete_build(user["id"], build_id)
            self._send_json({"ok": bool(ok)}, 200 if ok else 404)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args) -> None:
        message = format % args
        if "/status" in message:
            return  # status polling every 2 s would flood the terminal
        print(f"[server] {message}")


def main() -> None:
    panel_store.init_db()
    port = 9000
    server = ThreadingHTTPServer(("localhost", port), Handler)
    print(f"Control panel running at http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()