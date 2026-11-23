"""SQLite store for the console: users, sessions, providers (with encrypted secrets), capability routes, tasks/usage.
Boards and the asset library stay JSON files; they carry an `owner` user id.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
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
CREATE TABLE IF NOT EXISTS media_preferences (
  user_id INTEGER PRIMARY KEY, ai_watermark INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS task_watermarks (
  job_id TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS tasks_snapshot_watermark AFTER INSERT ON tasks
BEGIN
  DELETE FROM task_watermarks WHERE job_id=NEW.id;
  INSERT INTO task_watermarks SELECT NEW.id FROM media_preferences
  WHERE NEW.capability IN ('image','video') AND user_id=NEW.user_id AND ai_watermark=1;
END;
CREATE TRIGGER IF NOT EXISTS tasks_remove_watermark AFTER DELETE ON tasks
BEGIN
  DELETE FROM task_watermarks WHERE job_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS media_favorites (
  user_id INTEGER NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
  data TEXT NOT NULL, created REAL NOT NULL,
  PRIMARY KEY (user_id, ref));
CREATE INDEX IF NOT EXISTS media_favorites_user_created ON media_favorites(user_id, created DESC);
CREATE TABLE IF NOT EXISTS video_drafts (
 ref TEXT PRIMARY KEY, job_id TEXT NOT NULL, provider_task TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS creative_memories (
 id TEXT PRIMARY KEY, owner INTEGER, board TEXT NOT NULL DEFAULT '', shared INTEGER NOT NULL DEFAULT 0,
 kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS creative_memories_owner ON creative_memories(owner, board, deleted);
CREATE TABLE IF NOT EXISTS asset_folders (
 id TEXT PRIMARY KEY, owner INTEGER NOT NULL, name TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS asset_folders_name ON asset_folders(owner,name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS asset_folder_items (
 owner INTEGER NOT NULL, asset_id TEXT NOT NULL, folder_id TEXT NOT NULL, PRIMARY KEY(owner,asset_id));
CREATE INDEX IF NOT EXISTS asset_folder_items_folder ON asset_folder_items(folder_id);
CREATE TRIGGER IF NOT EXISTS asset_folders_remove AFTER DELETE ON asset_folders
BEGIN
 DELETE FROM asset_folder_items WHERE folder_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS memory_uploads (ref TEXT PRIMARY KEY, owner INTEGER NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS media_grants (ref TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(ref,user_id));
CREATE TABLE IF NOT EXISTS memory_jobs (
 id TEXT PRIMARY KEY, owner INTEGER NOT NULL, board TEXT NOT NULL, data TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS memory_outputs (
 ref TEXT NOT NULL, owner INTEGER NOT NULL, board TEXT NOT NULL, data TEXT NOT NULL, created REAL NOT NULL,
 PRIMARY KEY(ref, owner));
CREATE TABLE IF NOT EXISTS video_remakes (
 owner INTEGER NOT NULL, board TEXT NOT NULL, node TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL,
 PRIMARY KEY(owner, board, node, source));
CREATE TABLE IF NOT EXISTS canvas_projects (
 id TEXT PRIMARY KEY, owner INTEGER NOT NULL, name TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS canvas_teams (
 id TEXT PRIMARY KEY, owner INTEGER NOT NULL, name TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS canvas_team_members (
 team_id TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(team_id,user_id));
CREATE INDEX IF NOT EXISTS canvas_team_members_user ON canvas_team_members(user_id,team_id);
CREATE TABLE IF NOT EXISTS team_asset_folders (
 id TEXT PRIMARY KEY, team TEXT NOT NULL, name TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS team_asset_folders_name ON team_asset_folders(team,name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS team_asset_folder_items (
 asset_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS team_asset_folder_items_folder ON team_asset_folder_items(folder_id);
CREATE TRIGGER IF NOT EXISTS team_asset_folders_remove AFTER DELETE ON team_asset_folders
BEGIN
 DELETE FROM team_asset_folder_items WHERE folder_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS team_asset_scope_change AFTER UPDATE OF data,deleted ON creative_memories
WHEN NEW.deleted=1 OR COALESCE(json_extract(OLD.data,'$.team'),'')<>COALESCE(json_extract(NEW.data,'$.team'),'')
BEGIN
 DELETE FROM team_asset_folder_items WHERE asset_id=NEW.id;
END;
CREATE INDEX IF NOT EXISTS canvas_projects_owner ON canvas_projects(owner, created);
CREATE TABLE IF NOT EXISTS canvas_project_boards (
 board_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS canvas_project_boards_project ON canvas_project_boards(project_id);
CREATE TABLE IF NOT EXISTS canvas_comments (
 id TEXT PRIMARY KEY, board_id TEXT NOT NULL, thread_id TEXT, anchor TEXT, author_id INTEGER NOT NULL,
 body TEXT NOT NULL, created REAL NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, request_key TEXT NOT NULL,
 UNIQUE(board_id,author_id,request_key));
CREATE INDEX IF NOT EXISTS canvas_comments_board ON canvas_comments(board_id,created);
CREATE TABLE IF NOT EXISTS canvas_snapshots (
 board_id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, data TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS shared_canvas_items (
 token TEXT PRIMARY KEY, board_id TEXT NOT NULL, owner INTEGER NOT NULL,
 digest TEXT NOT NULL, data TEXT NOT NULL, media_ref TEXT, created REAL NOT NULL,
 UNIQUE(board_id,owner,digest));
CREATE INDEX IF NOT EXISTS shared_canvas_items_board ON shared_canvas_items(board_id,created);
CREATE TABLE IF NOT EXISTS showcase_entries (
 token TEXT PRIMARY KEY, board_id TEXT NOT NULL, owner INTEGER NOT NULL, node_id TEXT NOT NULL,
 video_ref TEXT NOT NULL, cover BLOB NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
 state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', submitted REAL NOT NULL, published REAL,
 snapshot TEXT, UNIQUE(board_id,node_id,video_ref));
CREATE INDEX IF NOT EXISTS showcase_state ON showcase_entries(state,published);
CREATE INDEX IF NOT EXISTS showcase_owner_state ON showcase_entries(owner,state,published);
CREATE TABLE IF NOT EXISTS showcase_prompts (
 token TEXT PRIMARY KEY, prompt TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS showcase_prompt_unlink AFTER DELETE ON showcase_entries
BEGIN
  DELETE FROM showcase_prompts WHERE token=OLD.token;
END;
CREATE TABLE IF NOT EXISTS creative_events (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL, rules TEXT NOT NULL,
 starts REAL NOT NULL, closes REAL NOT NULL, slots INTEGER NOT NULL,
 registration INTEGER NOT NULL, tracks TEXT NOT NULL, min_seconds REAL, max_seconds REAL);
CREATE TABLE IF NOT EXISTS event_registrations (
 event_id TEXT NOT NULL, owner INTEGER NOT NULL, note TEXT NOT NULL, state TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '', submitted REAL NOT NULL, PRIMARY KEY(event_id,owner));
CREATE TABLE IF NOT EXISTS event_entries (
 event_id TEXT NOT NULL, token TEXT NOT NULL, owner INTEGER NOT NULL, track TEXT NOT NULL,
 state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', submitted REAL NOT NULL, PRIMARY KEY(event_id,token));
CREATE INDEX IF NOT EXISTS event_entries_owner ON event_entries(event_id,owner);
CREATE INDEX IF NOT EXISTS event_entries_work ON event_entries(token);
CREATE TABLE IF NOT EXISTS connector_tokens (
 id TEXT PRIMARY KEY, owner INTEGER NOT NULL, label TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
 created REAL NOT NULL, expires REAL NOT NULL);
CREATE INDEX IF NOT EXISTS connector_tokens_owner ON connector_tokens(owner);
CREATE TABLE IF NOT EXISTS connector_oauth_clients (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, redirects TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, expires REAL);
CREATE INDEX IF NOT EXISTS connector_oauth_client_expiry ON connector_oauth_clients(expires);
CREATE TABLE IF NOT EXISTS connector_oauth_requests (
 id TEXT PRIMARY KEY, owner INTEGER NOT NULL, session_digest TEXT NOT NULL, data TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS connector_oauth_codes (
 digest TEXT PRIMARY KEY, owner INTEGER NOT NULL, data TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS connector_oauth_grants (
 token_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, resource TEXT NOT NULL,
 access_expires REAL NOT NULL, refresh_digest TEXT NOT NULL UNIQUE);
CREATE TRIGGER IF NOT EXISTS connector_oauth_revoke AFTER DELETE ON connector_tokens
BEGIN
 DELETE FROM connector_oauth_grants WHERE token_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS connector_runs (
 token_id TEXT NOT NULL, request_key TEXT NOT NULL, signature TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(token_id,request_key));
CREATE TABLE IF NOT EXISTS event_judging (
 event_id TEXT PRIMARY KEY, criteria TEXT NOT NULL, prizes TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event_results (
 event_id TEXT PRIMARY KEY, summary TEXT NOT NULL, revision INTEGER NOT NULL, published REAL NOT NULL);
CREATE TABLE IF NOT EXISTS event_awards (
 event_id TEXT NOT NULL, token TEXT NOT NULL, label TEXT NOT NULL, position INTEGER NOT NULL,
 PRIMARY KEY(event_id,token));
CREATE TRIGGER IF NOT EXISTS event_award_revoke AFTER DELETE ON event_entries
BEGIN
 DELETE FROM event_awards WHERE event_id=OLD.event_id AND token=OLD.token;
END;
CREATE TRIGGER IF NOT EXISTS showcase_event_revoke AFTER DELETE ON showcase_entries
BEGIN
 DELETE FROM event_entries WHERE token=OLD.token;
END;
CREATE TABLE IF NOT EXISTS showcase_creators (
 owner INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
INSERT OR IGNORE INTO showcase_creators(owner,slug)
 SELECT owner,lower(hex(randomblob(16))) FROM showcase_entries
 WHERE state='approved' AND owner NOT IN (SELECT owner FROM showcase_creators) GROUP BY owner;
CREATE TABLE IF NOT EXISTS canvas_templates (
 id TEXT PRIMARY KEY, owner INTEGER NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS canvas_templates_owner ON canvas_templates(owner,updated);
CREATE TABLE IF NOT EXISTS canvas_template_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, template_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS canvas_template_history_latest ON canvas_template_history(template_id,id DESC);
CREATE TRIGGER IF NOT EXISTS canvas_template_remove_history AFTER DELETE ON canvas_templates
BEGIN
  DELETE FROM canvas_template_history WHERE template_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS canvas_template_publications (
 template_id TEXT PRIMARY KEY, published REAL NOT NULL);
CREATE TABLE IF NOT EXISTS canvas_template_favorites (
 owner INTEGER NOT NULL, template_id TEXT NOT NULL, added REAL NOT NULL, PRIMARY KEY(owner,template_id));
CREATE INDEX IF NOT EXISTS canvas_template_favorites_by_template ON canvas_template_favorites(template_id);
CREATE TRIGGER IF NOT EXISTS canvas_template_remove_favorites AFTER DELETE ON canvas_templates
BEGIN
  DELETE FROM canvas_template_favorites WHERE template_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS showcase_template_links (
 token TEXT PRIMARY KEY, template_id TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS showcase_template_unlink AFTER DELETE ON showcase_entries
BEGIN
  DELETE FROM showcase_template_links WHERE token=OLD.token;
END;
CREATE TRIGGER IF NOT EXISTS deleted_template_unlink AFTER DELETE ON canvas_templates
BEGIN
  DELETE FROM showcase_template_links WHERE template_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS canvas_template_unpublish AFTER DELETE ON canvas_templates
BEGIN
  DELETE FROM canvas_template_publications WHERE template_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS creative_skills (
 id TEXT PRIMARY KEY, owner INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
 instructions TEXT NOT NULL, reference_data TEXT NOT NULL, automatic INTEGER NOT NULL, updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS creative_skills_owner ON creative_skills(owner,updated);
CREATE TABLE IF NOT EXISTS creative_skill_settings (
 owner INTEGER NOT NULL, skill_id TEXT NOT NULL, automatic INTEGER NOT NULL, PRIMARY KEY(owner,skill_id));
CREATE TABLE IF NOT EXISTS canvas_snapshot_copies (
 token TEXT NOT NULL, user_id INTEGER NOT NULL, board_id TEXT NOT NULL, PRIMARY KEY(token,user_id));
CREATE TRIGGER IF NOT EXISTS canvas_snapshot_revoke AFTER DELETE ON canvas_snapshots
BEGIN
  DELETE FROM canvas_snapshot_copies WHERE token=OLD.token;
END;
CREATE TRIGGER IF NOT EXISTS showcase_snapshot_revoke AFTER DELETE ON showcase_entries
BEGIN
  DELETE FROM canvas_snapshot_copies WHERE token=OLD.token;
END;
CREATE TRIGGER IF NOT EXISTS canvas_projects_dissolve AFTER DELETE ON canvas_projects
BEGIN
  UPDATE creative_memories
  SET data=json_set(data,'$.project',''),
      updated=max(updated+0.00001,(julianday('now')-2440587.5)*86400.0)
  WHERE owner=OLD.owner AND deleted=0 AND json_extract(data,'$.project')=OLD.id;
  DELETE FROM canvas_project_boards WHERE project_id=OLD.id;
END;
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


@contextmanager
def transaction():
    with _lock:
        connection = conn()
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise


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
