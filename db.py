"""SQLite store for the console: users, sessions, providers (with encrypted secrets), capability routes, tasks/usage.
Boards and the asset library stay JSON files; they carry an `owner` user id.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DB_PATH = DATA / "h3.db"
KEY_PATH = DATA / "secret.key"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT, pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', disabled INTEGER NOT NULL DEFAULT 0, created REAL, last_login REAL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created REAL, expires REAL);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, config TEXT NOT NULL DEFAULT '{}', secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS routes (
  capability TEXT NOT NULL, rank INTEGER NOT NULL, provider_id TEXT NOT NULL, model TEXT,
  PRIMARY KEY (capability, rank));
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, user_id INTEGER, board_id TEXT, label TEXT, capability TEXT, provider_id TEXT, provider_kind TEXT,
  model TEXT, state TEXT, created REAL, started REAL, finished REAL, seconds REAL, units REAL, cost REAL,
  error TEXT, outputs TEXT, request TEXT);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, created);
CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created);
CREATE TABLE IF NOT EXISTS creative_memories (
 id TEXT PRIMARY KEY, owner INTEGER, board TEXT NOT NULL DEFAULT '', shared INTEGER NOT NULL DEFAULT 0,
 kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS creative_memories_owner ON creative_memories(owner, board, deleted);
CREATE TABLE IF NOT EXISTS memory_uploads (ref TEXT PRIMARY KEY, owner INTEGER NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS memory_jobs (
 id TEXT PRIMARY KEY, owner INTEGER NOT NULL, board TEXT NOT NULL, data TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS memory_outputs (
 ref TEXT NOT NULL, owner INTEGER NOT NULL, board TEXT NOT NULL, data TEXT NOT NULL, created REAL NOT NULL,
 PRIMARY KEY(ref, owner));
CREATE TABLE IF NOT EXISTS video_remakes (
 owner INTEGER NOT NULL, board TEXT NOT NULL, node TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL,
 PRIMARY KEY(owner, board, node, source));
"""

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DATA.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
        os.chmod(DB_PATH, 0o600)
    return _conn


def q(sql: str, *args) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, args).fetchall()]


def one(sql: str, *args) -> dict | None:
    r = q(sql, *args)
    return r[0] if r else None


def run(sql: str, *args) -> int:
    with _lock:
        c = conn().execute(sql, args)
        return c.lastrowid


# ---------------------------------------------------------------- secrets (API keys)

def _fernet() -> Fernet:
    if not KEY_PATH.exists():
        DATA.mkdir(parents=True, exist_ok=True)
        KEY_PATH.write_bytes(Fernet.generate_key())
        os.chmod(KEY_PATH, 0o600)
    return Fernet(KEY_PATH.read_bytes())


def seal(d: dict) -> str:
    return _fernet().encrypt(json.dumps(d).encode()).decode() if d else ""


def unseal(s: str | None) -> dict:
    if not s:
        return {}
    try:
        return json.loads(_fernet().decrypt(s.encode()))
    except (InvalidToken, ValueError):
        return {}


def mask(v: str) -> str:
    v = v or ""
    return (v[:3] + "…" + v[-4:]) if len(v) > 10 else ("已设置" if v else "")


# ---------------------------------------------------------------- tasks / usage

def task_start(**kw):
    kw.setdefault("created", time.time())
    kw.setdefault("state", "queued")
    for k in ("outputs", "request"):
        if k in kw and not isinstance(kw[k], str):
            kw[k] = json.dumps(kw[k], ensure_ascii=False)[:20000]
    cols = ",".join(kw)
    run(f"INSERT OR REPLACE INTO tasks ({cols}) VALUES ({','.join('?' * len(kw))})", *kw.values())


def task_update(tid: str, **kw):
    if not kw:
        return
    for k in ("outputs",):
        if k in kw and not isinstance(kw[k], str):
            kw[k] = json.dumps(kw[k], ensure_ascii=False)[:20000]
    run(f"UPDATE tasks SET {','.join(k + '=?' for k in kw)} WHERE id=?", *kw.values(), tid)
