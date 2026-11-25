"""Persistent assistant data, state limits, and task directories."""
from __future__ import annotations

import copy
import json
import time
import uuid

from oneshot.assistant import agent_editing
from oneshot.assistant import creative_profile
from oneshot.storage import db


TERMINAL = {"done", "error", "stopped"}
EXPLAIN_SNAPSHOT = "请解读这张公开画布的制作过程。"
ACTIVE_RUN_SQL = "state IN ('thinking','running','waiting_input','waiting_approval','stopping')"
GENERATION_MODES = ("auto","smart","manual")
EXECUTION_SCOPES = ("full","analysis","plan","brainstorm")
MAX_QUEUED_RUNS = 8
MAX_PARALLEL_RUNS = 3
MAX_DOCUMENTS_PER_MESSAGE = 2
DOCUMENT_DRAFT_TTL = 86400
MAX_RUN_SECONDS = 1800
SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_sessions (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, board_id TEXT NOT NULL,
 title TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS chat_sessions_user ON chat_sessions(user_id, board_id, updated);
CREATE TABLE IF NOT EXISTS chat_runs (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id INTEGER NOT NULL, board_id TEXT NOT NULL,
 request_key TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, error TEXT,
 created REAL NOT NULL, updated REAL NOT NULL,
 UNIQUE(session_id, request_key));
CREATE INDEX IF NOT EXISTS chat_runs_board_state ON chat_runs(board_id,state,created);
CREATE INDEX IF NOT EXISTS chat_runs_session_state ON chat_runs(session_id,state,created);
CREATE TABLE IF NOT EXISTS chat_calls (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
 state TEXT NOT NULL, result TEXT, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS chat_node_writes (
 board_id TEXT NOT NULL, node_id TEXT NOT NULL, call_id TEXT NOT NULL,
 PRIMARY KEY(board_id,node_id));
CREATE INDEX IF NOT EXISTS chat_node_writes_call ON chat_node_writes(call_id);
CREATE TABLE IF NOT EXISTS chat_retries (
 call_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, retry_run_id TEXT);
CREATE TABLE IF NOT EXISTS chat_approvals (
 call_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
 plan TEXT NOT NULL, decision TEXT);
CREATE TABLE IF NOT EXISTS chat_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT,
 kind TEXT NOT NULL, data TEXT NOT NULL, created REAL NOT NULL);
CREATE INDEX IF NOT EXISTS chat_events_session ON chat_events(session_id, id);
CREATE INDEX IF NOT EXISTS chat_events_user_run ON chat_events(run_id, id) WHERE kind='user';
CREATE TABLE IF NOT EXISTS chat_documents (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created REAL NOT NULL);
CREATE INDEX IF NOT EXISTS chat_documents_session ON chat_documents(session_id,created);
CREATE TABLE IF NOT EXISTS chat_canvas_starts (
 owner INTEGER NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 board_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL UNIQUE, run_id TEXT,
 PRIMARY KEY(owner,request_key));
"""


def dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def ident(prefix):
    return prefix + uuid.uuid4().hex[:20]


def active_board_runs(board_id):
    return db.q(f"SELECT session_id FROM chat_runs WHERE board_id=? AND {ACTIVE_RUN_SQL}",board_id)


def session_waits(session_id, active):
    return (len(active) >= MAX_PARALLEL_RUNS or any(run["session_id"] == session_id for run in active) or
            bool(db.one("SELECT 1 FROM chat_runs WHERE session_id=? AND state='queued'",session_id)))


QUEUED_TASK_FIELDS = """id,COALESCE(json_extract(data,'$.queued_turn.event.text'),
                            CASE WHEN json_type(data,'$.retry_call') IS NOT NULL THEN '按原参数重试' END) AS text,
                            json_type(data,'$.retry_call') IS NULL AS removable"""


def session_directory(user_id, board_id):
    rows = db.q(f"""SELECT s.*,r.state AS run_state,r.id AS active_run,r.updated AS active_updated,
                   json_extract(r.data,'$.selected') AS run_nodes,
                   (SELECT SUBSTR(json_extract(e.data,'$.text'),1,180) FROM chat_events e
                    WHERE e.run_id=r.id AND e.kind='user' ORDER BY e.id LIMIT 1) AS active_text,
                   recent.id AS recent_run,recent.state AS recent_state,recent.updated AS recent_updated,
                   (SELECT COUNT(*) FROM chat_runs r WHERE r.session_id=s.id AND r.state='queued') AS queued_count
                   FROM chat_sessions s LEFT JOIN chat_runs r ON r.id=(SELECT id FROM chat_runs
                       WHERE session_id=s.id AND {ACTIVE_RUN_SQL} ORDER BY created LIMIT 1)
                   LEFT JOIN chat_runs recent ON recent.id=(SELECT id FROM chat_runs WHERE session_id=s.id
                       AND state IN ('done','error','stopped') AND json_type(data,'$.discarded_before_start') IS NULL
                       ORDER BY created DESC,id DESC LIMIT 1)
                   WHERE s.user_id=? AND s.board_id=?
                   ORDER BY (run_state IS NOT NULL OR queued_count>0) DESC,s.updated DESC LIMIT 40""",user_id,board_id)
    queued = {}
    for task in db.q(f"""SELECT session_id,{QUEUED_TASK_FIELDS},rowid AS position FROM chat_runs
                         WHERE board_id=? AND user_id=? AND state='queued' ORDER BY rowid""",board_id,user_id):
        sid = task.pop("session_id")
        task["text"] = task["text"][:180] if task["text"] else ""
        queued.setdefault(sid,[]).append(task)
    for row in rows:
        run, nodes = row.pop("active_run"),row.pop("run_nodes")
        active_updated = row.pop("active_updated")
        active_text = row.pop("active_text")
        recent, state, updated = row.pop("recent_run"),row.pop("recent_state"),row.pop("recent_updated")
        if recent:
            row["recent_task"] = {"id":recent,"state":state,"updated":updated}
        if run:
            row["active_task_id"] = run
            row["active_task_updated"] = active_updated
            if active_text:
                row["active_task_text"] = active_text
            calls = db.q("SELECT id FROM chat_calls WHERE run_id=? AND state!='done'",run)
            row["node_activity"] = {"nodes":json.loads(nodes) if nodes else [],"calls":[call["id"] for call in calls]}
        if tasks := queued.get(row["id"]):
            row["queued_tasks"] = tasks
    return rows


def task_directory_snapshot(user_id, board_id):
    sessions = session_directory(user_id,board_id)
    return {"sessions":sessions,"task_snapshot_at":time.time()}


SCHEMA += agent_editing.SCHEMA + creative_profile.SCHEMA


class ToolError(Exception):
    pass


class InternalRequest(dict):
    """Use the same business handlers, under the real user's identity."""
    def __init__(self, service, user, payload=None, path="", query=None):
        super().__init__(user=user)
        self.app, self.payload, self.path = service.app, payload or {}, path
        self.query = query or {}

    async def json(self):
        return copy.deepcopy(self.payload)
