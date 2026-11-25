"""Validate canvas state and commit assistant operations and versioned results."""
from __future__ import annotations

from pathlib import Path
import copy
import math
import re
import uuid

from oneshot.assistant import agent_editing
from oneshot.assistant import agent_video
from oneshot.assistant.chat_state import ToolError
from oneshot.memory import creative_memory
from oneshot.memory import document_review
from oneshot.storage import db


class CanvasOperations:
    def board(self, user, bid):
        if not isinstance(bid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", bid):
            raise ToolError("画布编号格式不正确")
        account = db.one("SELECT id,role,disabled FROM users WHERE id=?", user["id"])
        if not account or account["disabled"]:
            raise ToolError("账号已不可用")
        p = self.host.board_path(bid)
        if not p.exists():
            raise ToolError("画布已不存在")
        b = self.host.board_meta(p)
        if not b or not self.host.can_see(account, b):
            raise ToolError("没有权限操作这个画布")
        if not self.host.can_edit(account, b):
            raise ToolError("审阅权限无法在此画布执行助手操作")
        creative_memory.remove_deleted_bindings(b)
        return b

    @staticmethod
    def current(n):
        vs, cur = n.get("versions") or [], n.get("cur", -1)
        return vs[cur] if type(cur) is int and 0 <= cur < len(vs) else None

    @staticmethod
    def node_state(n):
        return {"name": n.get("name"), "text": n.get("data", {}).get("text"), "x": n.get("x"), "y": n.get("y")}

    def context(self, user, bid, data):
        b = self.board(user, bid)
        nodes = []
        selected = set(data.get("selected", []))
        bindings = {nid:ref for nid,ref in data.get("bindings",{}).items() if nid in selected}
        ordered = sorted(b.get("nodes", []), key=lambda n: n["id"] not in selected)
        for n in ordered[:80]:
            v = self.current(n)
            ref = bindings.get(n["id"])
            index = next((i for i,version in enumerate(n.get("versions",[]),1) if version.get("ref")==ref),None) if ref else None
            composition = self.previs_composition(n) if n["type"]=="image" else None
            nodes.append({"id": n["id"], "type": n["type"], "name": n.get("name"), "x": n.get("x"), "y": n.get("y"),
                          "version_count": len(n.get("versions") or []), "current": v and {k: (v.get(k) or "")[:500] if k == "prompt" else v.get(k) for k in ("ref", "w", "h", "seconds", "prompt", "source", "draft_expires")},
                          **({"reference_version":index} if index else {}),
                          **({"locked":True} if n.get("locked") is True else {}),
                          **({"previs":True} if n.get("data", {}).get("previs") else {}),
                          **({"previs_composition":composition["ref"]} if composition else {}),
                          **({"playlist":True} if n.get("data", {}).get("playlist") else {}),
                          "has_recipe": bool((v or {}).get("edit", {}).get("recipe")), "has_layers": bool((v or {}).get("layer_stack") or (v or {}).get("edit", {}).get("layer")),
                          "text": (n.get("data", {}).get("text") or "")[:400]})
        return {"board_id": bid, "name": b.get("name"), "rev": b.get("rev"), "selected": data.get("selected", []),
                "bound_versions": bindings,
                "attached_selection": data.get("attached_selection"),
                "attached_review": document_review.visible_anchor(data.get("attached_review")),
                "attached_reviews": [document_review.visible_anchor(item) for item in
                                     (data.get("attached_reviews") or ([data["attached_review"]] if data.get("attached_review") else []))],
                "placement": data.get("placement"),
                "nodes": nodes, "total_nodes": len(b.get("nodes", [])), "edges": b.get("edges", [])[:200],
                "groups": [{"id": group["id"], "name": group.get("name"), "nodes": group.get("nodes", [])[:80]}
                           for group in b.get("groups", [])[:20] if group.get("id")],
                "selections": agent_editing.selections(data.get("session_id"))[:8],
                "adopted_memory": [self.app["creative_memory"].summary(self.app["creative_memory"].get(user, mid, bid), data.get("memory_query","")) for mid in data.get("memory_ids", [])],
                "memory_candidates": [self.app["creative_memory"].summary(a,data.get("memory_query","")) for a in self.app["creative_memory"].list(user, bid, data.get("memory_query", ""))[:8]]}

    def source(self, run, user, nid, pinned_ref=None):
        b = self.board(user, run["board_id"])
        n = next((n for n in b.get("nodes", []) if n["id"] == nid), None)
        if not n or n.get("type") != "image":
            raise ToolError("图片节点不存在，请重新读取画布")
        ref = pinned_ref or run["data"]["bindings"].get(nid)
        versions = n.get("versions") or []
        v = next((v for v in versions if v.get("ref") == ref), None) if ref else self.current(n)
        if not v:
            raise ToolError("引用的图片版本已不存在或尚未生成")
        if not pinned_ref:
            run["data"]["bindings"][nid] = v["ref"]
            self.update(run)
        return n, copy.deepcopy(v)

    def commit(self, run, user, call_id, change):
        """No await between read/check/write; idempotency marker and effects commit together."""
        b = self.board(user, run["board_id"])
        ops = b.setdefault("agent_ops", [])
        old = next((o for o in ops if o["id"] == call_id), None)
        if old:
            return old["result"]
        before = copy.deepcopy(b.get("nodes", []))
        before_edges = copy.deepcopy(b.get("edges", []))
        result = change(b)
        after = b.get("nodes", [])
        old_nodes = {n["id"]: n for n in before}
        if (point := run["data"].get("placement")) and not call_id.startswith("undo_"):
            self.place_new_nodes(b, old_nodes, point)
        new_nodes = {n["id"]: n for n in after}
        changed = [nid for nid in old_nodes.keys() | new_nodes.keys() if old_nodes.get(nid) != new_nodes.get(nid)]
        owner = call_id.removeprefix("queued_").removeprefix("failed_")
        if changed and any(row["node_id"] in changed and row["call_id"] != owner for row in db.q(
                "SELECT node_id,call_id FROM chat_node_writes WHERE board_id=?",run["board_id"])):
            raise ToolError("另一个助手正在写入相关节点，请稍后重试")
        result["undo"] = {nid: {"before": old_nodes.get(nid), "after": new_nodes.get(nid)} for nid in changed}
        result["undo_edges"] = {"added": [e for e in b.get("edges", []) if e not in before_edges],
                                "removed": [e for e in before_edges if e not in b.get("edges", [])]}
        result["board_rev"] = int(b.get("rev") or 0) + 1
        ops.append({"id": call_id, "run": run["id"], "result": result})
        b["agent_ops"] = ops[-100:]
        b["rev"] = result["board_rev"]
        b = self.host.clean_board(b)
        self.host.write_board(self.host.board_path(run["board_id"]), b)
        for nid in changed:
            if nid in new_nodes:
                run["data"].setdefault("node_state", {})[nid] = self.node_state(new_nodes[nid])
        self.update(run)
        self.emit(run["session_id"], run["id"], "board", {"rev": b["rev"]})
        return result

    @staticmethod
    def placement_size(n):
        kind, data = n.get("type"), n.get("data") or {}
        if kind in ("text", "audio"):
            return (300, 220) if kind == "text" else (320, 120)
        if kind == "script":
            return 440, min(620, max(300, 96 + 92 * len(data.get("shots") or [])))
        v = CanvasOperations.current(n) or {}
        width, height = v.get("w"), v.get("h")
        if type(width) in (int, float) and type(height) in (int, float) and width > 0 and height > 0:
            aspect = width / height
        else:
            ratios = {"16:9": 16/9, "9:16": 9/16, "1:1": 1, "4:3": 4/3, "3:4": 3/4, "21:9": 21/9}
            aspect = ratios.get(str(data.get("aspect")), 1 if kind == "image" else 16/9)
        if kind == "image":
            width = max(220, min(460, math.sqrt(114000 * aspect)))
        else:
            width = max(240, min(520, math.sqrt(110000 * aspect)))
        return round(width), round(width / aspect)

    def place_new_nodes(self, board, previous, point):
        nodes = board.get("nodes", [])
        added = [n for n in nodes if n["id"] not in previous]
        if not added:
            return
        x, y = point["x"], point["y"]
        gap_x, gap_y = 60, 44
        obstacles, hidden = [], set()
        for group in board.get("groups") or []:
            fold = group.get("fold")
            if group.get("collapsed") is not True or not isinstance(fold, dict):
                continue
            position = (fold.get("x"), fold.get("y"))
            if all(type(v) in (int, float) and math.isfinite(v) for v in position):
                obstacles.append((*position, 270, 96))
                hidden.update(group.get("nodes") or [])
        obstacles.extend((n.get("x") or 0, n.get("y") or 0, *self.placement_size(n)) for n in nodes
                         if n["id"] in previous and n["id"] not in hidden)
        for n in added:
            width, height = self.placement_size(n)
            for left, top, w, h in sorted(obstacles):
                if y >= top + h + gap_y or y + height + gap_y <= top:
                    continue
                if x < left + w + gap_x and x + width + gap_x > left:
                    x = left + w + gap_x
            n["x"], n["y"] = round(x), y
            obstacles.append((n["x"], y, width, height))
            x += width + gap_x

    @staticmethod
    def dimensions(n):
        v = CanvasOperations.current(n) or {}
        if n.get("type") == "text":
            return 300, 220
        if n.get("type") == "audio":
            return 320, 120
        ar = (v.get("w") or 1) / (v.get("h") or 1)
        w = max(220, min(460, math.sqrt(114000 * ar)))
        return round(w), round(w / ar)

    def add_results(self, run, user, cid, versions, name, prompt="", kind="image", target_id=None, *, variants=None):
        def change(b):
            nodes = b.setdefault("nodes", [])
            def add_subtitle(source, version):
                transcript = version.get("audio_transcript")
                if kind != "audio" or not transcript or not transcript.get("cues"):
                    return
                nid = "nsub_" + re.sub(r"[^A-Za-z0-9_-]", "_", Path(version["ref"]).stem)[:35]
                if any(item["id"] == nid for item in nodes):
                    return
                x = max(item.get("x",0) + self.dimensions(item)[0] for item in nodes) + 110
                ref = version["ref"]
                text = "\n".join(cue["text"] for cue in transcript["cues"])
                nodes.append({"id":nid,"type":"text","name":source["name"]+" · 字幕","x":x,"y":source["y"],
                              "data":{"text":text,"transcript":{**transcript,"source_node":source["id"],"source_ref":ref}},
                              "versions":[],"cur":-1,"job":None})
                b.setdefault("edges",[]).append({"from":source["id"],"to":nid,"relation":"transcript","source_ref":ref})

            if target_id:
                target = next((n for n in nodes if n["id"] == target_id), None)
                if not target:
                    return {"nodes": [], "media_type": kind, "notice": "原节点已删除，未重新创建；生成文件仍保留在素材库"}
                if target.get("type") != kind:
                    raise ToolError("原节点媒体类型已改变，未写入结果")
                if target.get("job") and target["job"].get("agent_call") != cid:
                    raise ToolError("原节点已有其他任务，未覆盖其版本")
                if kind == "video" and versions:
                    latest = versions[-1]
                    if latest.get("draft_final") or latest.get("film_recipe", {}).get("timeline"):
                        agent_video.restore_video_snapshot(b,target,latest)
                made = []
                for version in versions:
                    target.setdefault("versions", []).append({**version, "label": name[:80]})
                    target["cur"] = len(target["versions"]) - 1
                    add_subtitle(target,version)
                    made.append({"id": target_id, "type": kind, "name": target["name"], "ref": version["ref"],
                                 "url": version["url"], "version_index": target["cur"]})
                if (target.get("job") or {}).get("agent_call") == cid:
                    target["job"] = None
                target.pop("agent_error", None)
                return {"nodes": made, "media_type": kind}
            x = max((n.get("x", 0) + self.dimensions(n)[0] for n in nodes), default=20) + 100
            y = min((n.get("y", 100) for n in nodes), default=100)
            made = []
            for i, v in enumerate(versions):
                nid = "a" + uuid.uuid5(uuid.NAMESPACE_URL, cid + str(i)).hex[:20]
                label = variants[i]["name"] if variants else name + (f" {i + 1}" if len(versions) > 1 else "")
                node = {"id": nid, "type": kind, "name":label[:40],
                        "x": x, "y": y, "data": {"prompt":v["prompt"] if variants else prompt, "model": "h3img",
                                                    "aspect":variants[i]["aspect"] if variants else "auto", "quality": "4mp", "count": 1,
                                                    "seed": v.get("seed") if v.get("seed") is not None else -1, "expand": False, "turbo": True, "caption": ""},
                        "versions": [v], "cur": 0, "job": None}
                if kind in ("video","audio"):
                    existing = next((n for n in nodes if n["id"] == nid), None)
                    queued = any(op["id"] == "queued_" + cid for op in b.get("agent_ops", []))
                    if existing:
                        if kind == "video" and (draft := v.get("draft_final")):
                            binding = next((edge for edge in b.get("edges", []) if edge.get("to") == nid
                                            and edge.get("relation") == "draft_final" and edge.get("ref") == draft["source_ref"]), None)
                            if binding:
                                v = {**v,"draft_final":{**draft,"source_node":binding["from"]},
                                     "input_edges":[copy.deepcopy(binding)]}
                        if not any(old.get("ref") == v["ref"] for old in existing.get("versions", [])):
                            existing.setdefault("versions", []).append(v)
                            existing["cur"] = len(existing["versions"]) - 1
                        if (existing.get("job") or {}).get("agent_call") == cid:
                            existing["job"] = None
                        existing.pop("agent_error", None)
                        node = existing
                    elif queued:
                        continue  # User deleted the pending node; do not recreate it.
                    else:
                        node["data"] = agent_video.node_data(v.get("video_recipe") or {}) if kind=="video" else dict(v["audio_recipe"])
                        nodes.append(node)
                        if kind=="video":
                            agent_video.connect_inputs(self, b, nid, v.get("video_recipe") or {})
                else:
                    nodes.append(node)
                add_subtitle(node,v)
                made.append({"id": nid, "type": kind, "name": node["name"], "ref": v["ref"], "url": v["url"]})
                x += self.dimensions(node)[0] + 60
            return {"nodes": made, "media_type": kind}
        result = self.commit(run, user, cid, change)
        for n in result["nodes"]:
            run["data"]["bindings"][n["id"]] = n["ref"]
        self.update(run)
        return result
