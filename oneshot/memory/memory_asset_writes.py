"""Validate and persist asset records, uploads, and conversation archives."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote
import copy
import math
import time
import uuid

from oneshot.memory import document_import
from oneshot.memory.memory_values import (
    AUDIO_EXT,
    CHARACTER_FIELDS,
    CHARACTER_VIEWS,
    IMAGE_EXT,
    KINDS,
    dumps,
    fail,
    generation_media_type,
    text,
)
from oneshot.storage import db


class AssetWrites:
    def media(self, user, ref, bid="", nid=None):
        if not isinstance(ref, str):
            fail("素材引用无效")
        try:
            path = self.h.tools.ref_path(self.h.COMFY_DIR, ref)
            if not path.is_file():
                fail("素材文件不存在")
        except (ValueError, OSError):
            fail("素材引用无效")
        version, node_type = None, None
        if bid:
            b = self.board(user, bid)
            version, node_type = next(((v,n.get("type")) for n in b.get("nodes", []) if not nid or n["id"] == nid
                                       for v in n.get("versions", []) if v.get("ref") == ref), (None,None))
        uid = user["id"]
        allowed = (user["role"] == "admin" or version
                   or db.one("SELECT 1 FROM memory_uploads WHERE ref=? AND owner=?", ref, uid)
                   or db.one("SELECT 1 FROM memory_outputs WHERE ref=? AND owner=?", ref, uid)
                   or db.one("SELECT 1 FROM media_grants WHERE ref=? AND user_id=?", ref, uid))
        if not allowed:
            project = self.project(user, bid)
            teams = self.teams(user)
            allowed = any(m.get("ref") == ref for a in self.all() if self.visible(a, user, bid or None, project, teams) for m in a.get("media", []))
        if not allowed:
            fail("请从可访问画布选取素材或上传文件", 403)
        result = {"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "source": (version or {}).get("source") or ("upload" if ref.startswith("input:") else "generated"),
                  "board": bid, "node_id": nid, "created": time.time(), "role": "reference"}
        if path.suffix.lower() in IMAGE_EXT:
            from PIL import Image
            try:
                with Image.open(path) as im:
                    result.update(w=im.width, h=im.height, type="image")
            except OSError:
                fail("参考图片无法读取")
        else:
            result["type"] = "audio" if node_type == "audio" or path.suffix.lower() in AUDIO_EXT else "video"
            if version:
                result.update({k:version[k] for k in ("w","h","seconds") if type(version.get(k)) in (int,float)})
            if "seconds" not in result:
                try:
                    if result["type"] == "audio":
                        result["seconds"] = round(self.h.film.audio_duration(path),2)
                    else:
                        info = self.h.media_info(path,"video")
                        if info:
                            result.update(w=info["width"],h=info["height"],seconds=info["duration"])
                except (ValueError, OSError, IndexError):
                    pass
        return result

    def put(self, user, p, stable_id=None):
        if not isinstance(p, dict):
            fail("记忆格式不正确")
        if p.get("id") is not None and not isinstance(p["id"], str):
            fail("记忆编号无效")
        if p.get("ref") is not None and not isinstance(p["ref"], str):
            fail("素材引用无效")
        old = self.get(user, p["id"]) if p.get("id") else None
        if old and not (user["role"] == "admin" or old["owner"] in (None, user["id"])):
            fail("只能修改自己的记忆", 403)
        if old and old["board"] and not self.h.can_edit(user, self.board(user, old["board"])):
            fail("审阅权限无法修改画布素材", 403)
        if old and p.get("mtime") is not None and p["mtime"] != old["mtime"]:
            fail("记忆已更新，请重新打开后再修改", 409)
        a = copy.deepcopy(old or {"id": stable_id or "m" + uuid.uuid4().hex[:16], "owner": user["id"], "board": "", "project": "", "team":"", "shared": False,
                                  "kind": "character", "name": "", "desc": "", "constraints": "", "voice": "", "aliases": [], "tags": [], "media": [], "default_ref": ""})
        if old and a["owner"] is None:
            a["owner"] = user["id"]
        if stable_id and not old:
            prior = db.one("SELECT * FROM creative_memories WHERE id=?", stable_id)
            if prior:
                return self.get(user, stable_id)
        for k in ("name", "desc", "constraints", "voice", "board", "project", "team", "kind"):
            if k in p:
                a[k] = text(p[k], 80 if k in ("name", "kind", "board", "project", "team") else 6000)
        if not a["name"] or a["kind"] not in KINDS or "@" in a["name"]:
            fail("请填写有效的记忆名称和分类，名称不包含 @")
        if sum(bool(a[k]) for k in ("board","project","team")) > 1:
            fail("请选择一个资产范围")
        if a["team"] and a["team"] not in self.teams(user):
            fail("只能把资产保存到你所属的团队",403)
        if a["board"]:
            board = self.board(user, a["board"])
            if not self.h.can_edit(user, board):
                fail("审阅权限无法修改画布素材", 403)
        if a["project"]:
            if not db.one("SELECT 1 FROM canvas_projects WHERE id=? AND owner=?", a["project"], a["owner"]) or a["owner"] != user["id"]:
                fail("只能把资产保存到自己管理的项目", 403)
        if "shared" in p:
            if type(p["shared"]) is not bool:
                fail("共享设置无效")
            a["shared"] = p["shared"]
        if "document" in p:
            document = p["document"]
            if document is None:
                a.pop("document",None)
            elif isinstance(document,dict) and isinstance(document.get("text"),str) and document["text"].strip():
                fmt = document.get("format")
                raw = document["text"] if fmt in ("plain", "markdown") else document["text"].strip()
                a["document"] = {"name":text(document.get("name"),240),"text":raw[:document_import.MAX_TEXT],
                                 "truncated":bool(document.get("truncated")) or len(raw)>document_import.MAX_TEXT}
                if fmt in ("plain", "markdown"):
                    a["document"]["format"] = fmt
            else:
                fail("文档内容无效")
        for k in ("aliases", "tags"):
            if k in p:
                if not isinstance(p[k], list) or len(p[k]) > 30:
                    fail("别名或标签过多")
                a[k] = list(dict.fromkeys(text(x, 80) for x in p[k] if x))
        if "story_scenes" in p:
            scenes = p["story_scenes"]
            if not isinstance(scenes,list) or len(scenes)>12 or any(not isinstance(scene,str) for scene in scenes):
                fail("场次关键词最多填写 12 项")
            a["story_scenes"] = list(dict.fromkeys(scene for value in scenes if (scene := text(value,80))))
        if "story_draft" in p:
            if type(p["story_draft"]) is not bool:
                fail("创作记忆状态无效")
            a["story_draft"] = p["story_draft"]
        new_ref = p.get("ref")
        if new_ref and not any(m["ref"] == new_ref for m in a["media"]):
            a["media"].append(self.media(user, new_ref, p.get("source_board") or p.get("board") or "", p.get("node_id")))
        if len(a["media"]) > 100:
            fail("每条记忆最多保留100项参考素材")
        if a["kind"]!="character":
            a.pop("story_states",None)
        elif "story_states" in p:
            states = p["story_states"]
            if not isinstance(states,list) or len(states)>12 or any(not isinstance(item,dict) for item in states):
                fail("每个角色最多填写 12 种场次状态")
            refs = {item["ref"] for item in a["media"] if Path(item["ref"]).suffix.lower() in IMAGE_EXT}
            normalized = [{"scene":text(item.get("scene",""),80),"notes":text(item.get("notes",""),1200),
                           "ref":text(item.get("ref",""),300)} for item in states]
            if (any(not item["scene"] or not (item["notes"] or item["ref"]) or item["ref"] and item["ref"] not in refs
                    for item in normalized) or len({item["scene"].casefold() for item in normalized}) != len(normalized)):
                fail("场次关键词须唯一，每项须填写状态或选择此角色的定稿图")
            a["story_states"] = normalized
        if "default_ref" in p:
            chosen = p["default_ref"]
            if chosen and not any(m["ref"] == chosen and Path(chosen).suffix.lower() in IMAGE_EXT for m in a["media"]):
                fail("默认参考必须是此记忆内的图片")
            a["default_ref"] = chosen
        elif not a["default_ref"] and new_ref and Path(new_ref).suffix.lower() in IMAGE_EXT:
            a["default_ref"] = new_ref
        if "generation_media" in p:
            selected = p["generation_media"]
            available = {m["ref"]:m for m in a["media"]}
            if (not isinstance(selected, list) or len(selected) > 50 or
                    any(not isinstance(ref, str) or ref not in available for ref in selected) or
                    len(set(selected)) != len(selected)):
                fail("请选择此资产内不同的生成参考素材")
            for kind, maximum in (("image",30),("video",10),("audio",10)):
                if sum(generation_media_type(ref,available[ref]) == kind for ref in selected) > maximum:
                    fail(f"每组最多选择 {maximum} 项同类型参考素材")
            a.pop("generation_images", None)
            if selected:
                a["generation_media"] = selected
            else:
                a.pop("generation_media", None)
        elif "generation_images" in p:
            selected = p["generation_images"]
            available = {m["ref"] for m in a["media"] if Path(m["ref"]).suffix.lower() in IMAGE_EXT}
            if (not isinstance(selected, list) or len(selected) > 9 or
                    any(not isinstance(ref, str) or ref not in available for ref in selected) or
                    len(set(selected)) != len(selected)):
                fail("生成参考须为此资产内最多 9 张不同的图片")
            if selected:
                a["generation_images"] = selected
            else:
                a.pop("generation_images", None)
        selected = set(a.get("generation_media", []))
        for kind,label in (("video","视频"),("audio","音频")):
            key = f"generation_{kind}_ranges"
            media_lengths = {media["ref"]:media.get("seconds") for media in a["media"]
                             if media["ref"] in selected and generation_media_type(media["ref"],media)==kind}
            if key in p:
                ranges = p[key]
                if not isinstance(ranges,dict) or ranges.keys()-media_lengths.keys():
                    fail(f"只能为已选中的参考{label}设置片段")
                for ref,span in ranges.items():
                    if (not isinstance(span,list) or len(span)!=2 or
                            any(type(value) not in (int,float) or not 0<=value<math.inf for value in span)):
                        fail(f"参考{label}入点和出点须为有效秒数")
                    start,end = span
                    duration = media_lengths[ref]
                    if end-start < 2-1e-8 or (duration is not None and end>duration+.025):
                        fail(f"参考{label}片段须在原素材内，且至少 2 秒")
            else:
                ranges = {ref:span for ref,span in a.get(key,{}).items() if ref in media_lengths}
            if ranges:
                a[key] = ranges
            else:
                a.pop(key,None)
        if a["kind"] == "character":
            if "character_card" in p:
                card = p["character_card"]
                if not isinstance(card, dict) or card.keys() - CHARACTER_FIELDS.keys():
                    fail("角色卡格式不正确")
                a["character_card"] = {key: text(value, 800) for key, value in card.items()}
            if "character_view" in p:
                slot = p["character_view"]
                if not isinstance(slot, str) or slot not in CHARACTER_VIEWS or not new_ref or Path(new_ref).suffix.lower() not in IMAGE_EXT:
                    fail("请为角色视角指定图片")
                views = a.setdefault("character_views", {})
                if slot != "main" and not views.get("main"):
                    fail("请先定稿角色主图")
                if slot == "main" and views.get("main") != new_ref:
                    # Other views were approved against the previous main image.
                    views.clear()
                views[slot] = new_ref
            if main := a.get("character_views", {}).get("main"):
                a["default_ref"] = main
        if (a["board"] or a["project"] or a["team"]) and a["shared"]:
            fail("共享资产请先保存到个人素材库")
        if a.get("conversation_source") and (a["kind"]!="document" or a["board"] or a["project"] or a["team"] or a["shared"]):
            fail("对话存档保存在个人资产库，可另存资料后再共享")
        db.run("INSERT INTO creative_memories(id,owner,board,shared,kind,name,data,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,board=excluded.board,shared=excluded.shared,kind=excluded.kind,name=excluded.name,data=excluded.data,updated=excluded.updated",
               a["id"], a["owner"], a["board"], int(a["shared"]), a["kind"], a["name"], dumps(a), time.time())
        return self.get(user, a["id"])

    def save_conversation(self, user, session, document, cursor, count):
        self.migrate()
        mid = "m" + uuid.uuid5(uuid.NAMESPACE_URL,dumps(["oneshot:chat-memory",user["id"],session["id"]])).hex
        with db.transaction():
            row = db.one("SELECT * FROM creative_memories WHERE id=? AND owner=?",mid,user["id"])
            saved = self.unpack(row) if row else None
            source = (saved or {}).get("conversation_source") or {}
            if row and not row["deleted"] and source.get("cursor",0)>=cursor:
                return saved
            if row and row["deleted"]:
                db.run("UPDATE creative_memories SET deleted=0 WHERE id=? AND owner=?",mid,user["id"])
            name = text((session.get("title") or "创作对话").replace("@","＠"),75) or "创作对话"
            payload = {"document":document}
            if row:
                payload["id"] = mid
            else:
                payload.update(name=f"对话 · {name}",kind="document",tags=["助手对话"],story_draft=True)
            asset = self.put(user,payload,stable_id=mid)
            provenance = {"session":session["id"],"board":session["board_id"],"cursor":cursor,"messages":count}
            db.run("UPDATE creative_memories SET data=json_set(data,'$.conversation_source',json(?)) WHERE id=? AND owner=?",
                   dumps(provenance),asset["id"],user["id"])
            return self.get(user, asset["id"])

    def duplicate(self, user, mid, board, key):
        source = self.get(user,mid,board)
        aid = "m"+uuid.uuid5(uuid.NAMESPACE_URL,dumps(["oneshot:asset-copy",user["id"],mid,key])).hex
        refs = [item["ref"] for item in source.get("media",[])]
        self.h.require_media(user,refs)
        copied = {k:source[k] for k in ("desc","constraints","voice","tags","default_ref","character_card","character_views","generation_images","generation_media","generation_video_ranges","generation_audio_ranges","document","story_scenes","story_draft","story_states") if k in source}
        copied["aliases"] = []
        copied["media"] = [{k:item[k] for k in ("ref","source","type","role","w","h","seconds") if k in item}
                           for item in source.get("media",[])]
        prefix = source["name"].replace("@","＠")
        with db.transaction():
            if db.one("SELECT 1 FROM creative_memories WHERE id=?",aid):
                return self.get(user,aid)
            names = {row["name"].casefold() for row in db.q("""SELECT name FROM creative_memories
                WHERE deleted=0 AND (owner=? OR shared=1 OR board=? OR
                json_extract(data,'$.team') IN (SELECT team_id FROM canvas_team_members WHERE user_id=?))""",
                user["id"],board,user["id"])}
            number, suffix = 1, " 副本"
            while (prefix[:80-len(suffix)]+suffix).casefold() in names:
                number += 1
                suffix = f" 副本 {number}"
            name = prefix[:80-len(suffix)]+suffix
            self.h.grant_media(user,*refs)
            db.run("""INSERT INTO creative_memories(id,owner,board,shared,kind,name,data,updated)
                      VALUES(?,?,'',0,?,?,?,?)""",aid,user["id"],source["kind"],name,dumps(copied),time.time())
        return self.get(user,aid)

    def package(self, asset):
        notes = [f"# {asset['name']}"]
        for key,label in (("desc","设定"),("constraints","约束"),("voice","音色"),("tags","标签")):
            value = asset.get(key)
            if value:
                notes.append(f"## {label}\n\n"+("、".join(value) if key=="tags" else value))
        for slot,label in CHARACTER_FIELDS.items():
            if value := asset.get("character_card",{}).get(slot):
                notes.append(f"**{label}**  {value}")
        entries = []
        if doc := asset.get("document"):
            entries.append(("背景资料."+("md" if doc.get("format")=="markdown" else "txt"),doc["text"].encode("utf-8")))
        views = {ref:slot for slot,ref in asset.get("character_views",{}).items() if slot in CHARACTER_VIEWS}
        for index,media in enumerate(asset.get("media",[]),1):
            ref = media["ref"]
            try:
                path = self.h.tools.ref_path(self.h.COMFY_DIR,ref)
            except ValueError:
                continue
            if not path.is_file() or path.suffix.lower() not in IMAGE_EXT | self.h.tools.VIDEO_EXT | AUDIO_EXT:
                continue
            label = views.get(ref) or ("默认参考" if ref==asset["ref"] else "参考素材")
            entries.append((f"{index:02d}-{label}{path.suffix.lower()}",path))
        return [("资产说明.md",("\n\n".join(notes)+"\n").encode("utf-8")),*entries]
