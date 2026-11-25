"""Read creative records and enforce workspace, account, and team access."""
from __future__ import annotations

from urllib.parse import quote
import json
import re
import time

from oneshot.memory.memory_values import dumps, fail
from oneshot.storage import db


def remove_deleted_bindings(board):
    """Drop live links to deleted assets without changing source media or history."""
    bindings = []
    for node in board.get("nodes") or []:
        data = node.get("data") if isinstance(node, dict) else None
        if not isinstance(data, dict):
            continue
        for key, id_key in (("asset", "id"), ("character_draft", "asset")):
            binding = data.get(key)
            mid = binding.get(id_key) if isinstance(binding, dict) else None
            if isinstance(mid, str) and mid:
                bindings.append((data, key, mid))
    if bindings:
        deleted = {mid for mid in {mid for _, _, mid in bindings}
                   if db.one("SELECT 1 FROM creative_memories WHERE id=? AND deleted=1", mid)}
        for data, key, mid in bindings:
            if mid in deleted:
                data.pop(key, None)


class AssetRecords:
    def __init__(self, host):
        self.h = host

    def migrate(self):
        # Original IDs remain stable. Tombstones prevent a deleted legacy item reappearing.
        for a in self.h.legacy_lib_load():
            if not a.get("id") or not a.get("name"):
                continue
            data = {**a, "board": "", "aliases": [], "tags": [], "constraints": "",
                    "default_ref": a.get("ref", ""), "media": []}
            if a.get("ref"):
                data["media"] = [{k: a[k] for k in ("ref", "w", "h", "url") if k in a} | {"source": "legacy", "role": "reference"}]
            db.run("INSERT OR IGNORE INTO creative_memories(id,owner,board,shared,kind,name,data,updated) VALUES(?,?,?,?,?,?,?,?)",
                   a["id"], a.get("owner"), "", int(bool(a.get("shared"))), a.get("kind", "prop"), a["name"], dumps(data), a.get("mtime") or time.time())

    def all(self):
        self.migrate()
        return [self.unpack(r) for r in db.q("SELECT * FROM creative_memories WHERE deleted=0 ORDER BY updated DESC")]

    @staticmethod
    def unpack(row):
        a = json.loads(row["data"])
        a.setdefault("project", "")
        a.setdefault("team", "")
        a.update(id=row["id"], owner=row["owner"], board=row["board"], shared=bool(row["shared"]), kind=row["kind"], name=row["name"], mtime=row["updated"])
        a["ref"] = a.get("default_ref") or ""
        a["url"] = "/media?ref=" + quote(a["ref"], safe="") if a["ref"] else ""
        lead = next((m for m in a.get("media", []) if m["ref"] == a["ref"]), {})
        a.update({k: lead.get(k) for k in ("w", "h")})
        return a

    @staticmethod
    def teams(user):
        return {row["team_id"] for row in db.q("SELECT team_id FROM canvas_team_members WHERE user_id=?",user["id"])}

    @staticmethod
    def visible(a, user, board=None, project=None, teams=None, project_boards=None):
        if a.get("conversation_source"):
            return a["owner"] == user["id"]
        if team := a.get("team"):
            return a["owner"] == user["id"] or team in (AssetRecords.teams(user) if teams is None else teams)
        if a.get("project"):
            return a["owner"] == user["id"] and (board is None or a["project"] == project)
        if board and project and a.get("board") and a["board"] != board and a["owner"] == user["id"]:
            siblings = AssetRecords.project_boards(project) if project_boards is None else project_boards
            return a["board"] in siblings
        return (bool(board and a["board"] == board) or user["role"] == "admin" or a["owner"] in (None, user["id"]) or a["shared"]) and (board is None or not a["board"] or a["board"] == board)

    @staticmethod
    def project(user, board):
        if not board:
            return None
        row = db.one("""SELECT p.id FROM canvas_projects p JOIN canvas_project_boards b ON b.project_id=p.id
                        WHERE b.board_id=? AND p.owner=?""", board, user["id"])
        return row["id"] if row else None

    @staticmethod
    def project_boards(project):
        return {row["board_id"] for row in db.q("SELECT board_id FROM canvas_project_boards WHERE project_id=?",project)} if project else set()

    def default_scope(self, user, bid):
        board = self.board(user,bid)
        if project := self.project(user,bid):
            return {"project":project}
        if (team := board.get("team")) and team in self.teams(user):
            return {"team":team}
        return {"board":bid}

    def scope_filter(self, user, bid, scope):
        if scope == "current":
            target = self.default_scope(user,bid)
            boards = {bid} | self.project_boards(target.get("project"))
            return lambda asset: asset.get("board") in boards or any(
                asset.get(key) == value for key,value in target.items()
            ) or (asset.get("conversation_source") or {}).get("board") in boards
        if scope == "personal":
            return lambda asset: asset["owner"] in (None,user["id"]) and not (
                asset.get("board") or asset.get("project") or asset.get("team")
            )
        if scope == "shared":
            return lambda asset: asset.get("shared",False)
        if scope.startswith("team:"):
            return lambda asset: asset.get("team") == scope[5:]
        return lambda asset: scope == "available"

    def board(self, user, bid):
        if not isinstance(bid, str) or not re.fullmatch(r"[\w-]{1,80}", bid):
            fail("画布编号无效")
        try:
            b = self.h.board_meta(self.h.board_path(bid))
        except (OSError, ValueError):
            fail("画布不存在", 404)
        if not b:
            fail("画布不存在", 404)
        if not self.h.can_see(user, b):
            fail("无法访问这个画布", 403)
        return b

    def get(self, user, mid, board=None):
        self.migrate()
        if board:
            self.board(user, board)
        row = db.one("SELECT * FROM creative_memories WHERE id=? AND deleted=0", mid)
        a = self.unpack(row) if row else None
        if not a or not self.visible(a, user, board, self.project(user, board)):
            fail("记忆不存在或不可访问", 404)
        if a["board"]:
            self.board(user, a["board"])
        return a

    def delete(self, user, mid):
        a = self.get(user, mid)
        if user["role"] != "admin" and a["owner"] not in (None, user["id"]):
            fail("只能删除自己的记忆", 403)
        if a["board"] and not self.h.can_edit(user, self.board(user, a["board"])):
            fail("审阅权限无法删除画布素材", 403)
        db.run("UPDATE creative_memories SET deleted=1,updated=? WHERE id=?", time.time(), mid)
