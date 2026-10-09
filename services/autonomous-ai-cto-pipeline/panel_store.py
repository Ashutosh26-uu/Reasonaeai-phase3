"""Accounts + build history for the control panel (SQLite, standard library only).

Tables
  users     id, name, email (unique), password_hash, created_at
  sessions  token_hash, user_id, expires_at          (login tokens, 7 days)
  builds    id, user_id, idea, project, state, result_json, error, created_at, finished_at

Passwords are salted + hashed with scrypt; login tokens are stored only as SHA-256 hashes.
"""
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "panel_data.db"
SESSION_SECONDS = 7 * 24 * 3600
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AuthError(Exception):
    """Bad input or bad credentials. The message is safe to show to the user."""


@contextmanager
def _db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                expires_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS builds (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                idea TEXT NOT NULL,
                project TEXT,
                state TEXT NOT NULL,
                result_json TEXT,
                error TEXT,
                created_at REAL NOT NULL,
                finished_at REAL
            );
            """
        )
        # A server restart kills background builds; don't leave them "running" forever.
        c.execute(
            "UPDATE builds SET state='interrupted', finished_at=? WHERE state IN ('queued','running')",
            (time.time(),),
        )


# ---------- passwords ----------
def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return salt.hex() + "$" + digest.hex()


def _check_password(password: str, stored: str) -> bool:
    salt_hex, digest_hex = stored.split("$", 1)
    candidate = _hash_password(password, bytes.fromhex(salt_hex)).split("$", 1)[1]
    return hmac.compare_digest(candidate, digest_hex)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_session(conn, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        (_token_hash(token), user_id, time.time() + SESSION_SECONDS),
    )
    return token


# ---------- accounts ----------
def signup(name: str, email: str, password: str) -> dict:
    name, email = (name or "").strip(), (email or "").strip().lower()
    if not 1 <= len(name) <= 60:
        raise AuthError("Please enter your name.")
    if not EMAIL_RE.match(email):
        raise AuthError("Please enter a valid email address.")
    if len(password or "") < 6:
        raise AuthError("Password must be at least 6 characters.")
    with _db() as c:
        try:
            cur = c.execute(
                "INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (name, email, _hash_password(password), time.time()),
            )
        except sqlite3.IntegrityError:
            raise AuthError("An account with this email already exists. Try logging in.")
        token = _new_session(c, cur.lastrowid)
    return {"token": token, "user": {"id": cur.lastrowid, "name": name, "email": email}}


def login(email: str, password: str) -> dict:
    email = (email or "").strip().lower()
    with _db() as c:
        row = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        # Same message for "no such user" and "wrong password" (don't leak which emails exist).
        if not row or not _check_password(password or "", row["password_hash"]):
            raise AuthError("Wrong email or password.")
        token = _new_session(c, row["id"])
    return {"token": token, "user": {"id": row["id"], "name": row["name"], "email": row["email"]}}


def user_for_token(token: str | None) -> dict | None:
    if not token:
        return None
    with _db() as c:
        row = c.execute(
            "SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND s.expires_at > ?",
            (_token_hash(token), time.time()),
        ).fetchone()
    return dict(row) if row else None


def logout(token: str | None) -> None:
    if token:
        with _db() as c:
            c.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))


# ---------- build history ----------
def add_build(build_id: str, user_id: int, idea: str, project: str | None) -> None:
    with _db() as c:
        c.execute(
            "INSERT INTO builds (id, user_id, idea, project, state, created_at) VALUES (?, ?, ?, ?, 'running', ?)",
            (build_id, user_id, idea, project, time.time()),
        )


def finish_build(build_id: str, state: str, result: dict | None = None, error: str | None = None) -> None:
    with _db() as c:
        c.execute(
            "UPDATE builds SET state=?, result_json=?, error=?, finished_at=? WHERE id=?",
            (state, json.dumps(result) if result else None, error, time.time(), build_id),
        )


def list_builds(user_id: int, limit: int = 50) -> list[dict]:
    with _db() as c:
        rows = c.execute(
            "SELECT * FROM builds WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", (user_id, limit)
        ).fetchall()
    out = []
    for r in rows:
        result = json.loads(r["result_json"]) if r["result_json"] else None
        out.append({
            "id": r["id"], "idea": r["idea"], "project": r["project"], "state": r["state"],
            "error": r["error"], "created_at": r["created_at"], "finished_at": r["finished_at"],
            "project_name": (result or {}).get("project_name"),
            "features": (result or {}).get("features", []),
        })
    return out


def delete_build(user_id: int, build_id: str) -> bool:
    with _db() as c:
        cur = c.execute("DELETE FROM builds WHERE id = ? AND user_id = ?", (build_id, user_id))
    return cur.rowcount > 0


def can_use_project(user_id: int, project: str) -> bool:
    """A user may resume a pipeline_runs folder if they built it, or if nobody owns it yet
    (runs made before accounts existed)."""
    with _db() as c:
        row = c.execute("SELECT user_id FROM builds WHERE project = ? LIMIT 1", (project,)).fetchone()
    return row is None or row["user_id"] == user_id
