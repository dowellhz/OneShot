"""Record generated asset provenance and recover character drafts."""
from __future__ import annotations

from pathlib import Path
import json
import time

from oneshot.memory.memory_values import (
    CHARACTER_VIEWS,
    IMAGE_EXT,
    dumps,
    fail,
)
from oneshot.storage import db


class GenerationHistory:
    def character_draft_request(self, user, payload, draft):
        if not isinstance(draft, dict) or not isinstance(draft.get("asset"), str):
            fail("角色草稿参数无效")
        slot = draft.get("slot")
        if not isinstance(slot, str) or slot not in CHARACTER_VIEWS or payload.get("kind") != "image":
            fail("角色草稿参数无效")
        board = payload.get("board")
        self.board(user, board)
        asset = self.get(user, draft["asset"], board)
        if asset["kind"] != "character" or (user["role"] != "admin" and asset["owner"] not in (None, user["id"])):
            fail("无法为此角色生成草稿", 403)
        source = asset.get("character_views", {}).get("main") or (asset["ref"] if slot == "main" else "")
        if not source or payload.get("images") != [{"ref": source}]:
            fail("角色参考图已改变，请重新打开角色详情", 409)
        return {"asset": asset["id"], "slot": slot, "source": source}

    def character_drafts(self, user, assets):
        by_id = {a["id"]: a for a in assets if a["kind"] == "character"}
        if not by_id:
            return
        rows = db.q("""SELECT m.id, m.data, t.state, t.outputs, t.error FROM memory_jobs m
                       LEFT JOIN tasks t ON t.id=m.id
                       WHERE m.owner=? AND json_extract(m.data, '$.character_draft') IS NOT NULL
                       ORDER BY m.created DESC""", user["id"])
        for row in rows:
            draft = json.loads(row["data"])["character_draft"]
            asset = by_id.get(draft["asset"])
            if asset is None:
                continue
            slot = draft["slot"]
            approved = asset.get("character_views", {})
            source = approved.get("main") or (asset["ref"] if slot == "main" else "")
            if draft["source"] != source:
                continue
            slots = asset.setdefault("character_drafts", {})
            if slot in slots:
                continue
            current = self.h.JOBS.get(row["id"], {})
            state = current.get("state") or row["state"]
            if state == "done":
                outputs = [out.get("ref") for out in current.get("outputs") or []] or json.loads(row["outputs"] or "[]")
                ref = next((ref for ref in outputs if isinstance(ref, str) and Path(ref).suffix.lower() in IMAGE_EXT), None)
                slots[slot] = ({"source": source, "ref": ref} if ref else
                               {"source": source, "error": "任务未返回图片，可重新生成"})
            elif state == "error":
                slots[slot] = {"source": source, "error": current.get("error") or row["error"] or "生成失败"}
            else:
                slots[slot] = {"source": source, "ids": [row["id"]]}

    def track(self, user, payload, result, character_draft=None):
        data = {"prompt": payload.get("prompt", ""), "memory_used": payload.get("memory_used", [])}
        if character_draft:
            data["character_draft"] = character_draft
        for jid in result.get("ids", []):
            db.run("INSERT OR IGNORE INTO memory_jobs VALUES(?,?,?,?,?)", jid, user["id"], payload.get("board") or "", dumps(data), time.time())

    def observe(self, user, states):
        for jid, state in states.items():
            if state.get("state") != "done":
                continue
            job = db.one("SELECT * FROM memory_jobs WHERE id=? AND owner=?", jid, user["id"])
            if not job:
                continue
            data = json.loads(job["data"])
            for out in state.get("outputs") or []:
                item = {**data, "ref": out["ref"], "source": "generated", "meta": out.get("meta") or {}, "job_id": jid}
                db.run("INSERT OR IGNORE INTO memory_outputs VALUES(?,?,?,?,?)", out["ref"], user["id"], job["board"], dumps(item), time.time())

    def history(self, user, mid, board=None):
        a = self.get(user, mid, board)
        result = []
        for row in db.q("SELECT * FROM memory_outputs WHERE owner=? ORDER BY created DESC", user["id"]):
            item = json.loads(row["data"])
            if item.get("character_draft", {}).get("asset") == a["id"] or any(m["id"] == a["id"] for m in item.get("memory_used", [])):
                result.append({**item, "created": row["created"], "board": row["board"]})
                if len(result) >= 60:
                    break
        return result
