"""Build generation input from pinned assets and reusable historical references."""
from __future__ import annotations

from collections import Counter
import copy
import json
import re

from oneshot.generation import motion_reference
from oneshot.memory.memory_values import (
    CHARACTER_VIEW_LABELS,
    IMAGE_STORY_KINDS,
    IMAGE_STORY_PROMPT_MARKER,
    MEMORY_PROMPT_MARKER,
    NAMED_REFERENCE,
    NUMBERED_AV_REFERENCE,
    fail,
    generation_context,
    generation_media_type,
    mention_pattern,
    recorded_reference_slots,
    requested_views,
    story_character_state,
    validate_numbered_av_references,
    view_selections,
    view_tokens,
)
from oneshot.storage import db


class GenerationContext:
    def historical_assets(self, user, output_ref):
        self.h.require_media(user, [output_ref])
        row = db.one("SELECT data FROM memory_outputs WHERE ref=? AND owner=?", output_ref, user["id"])
        if not row:
            fail("此版本没有可复用的资产参考记录")
        assets = {asset["id"]:asset for asset in json.loads(row["data"]).get("memory_used", [])}
        if not assets:
            fail("此版本没有使用资产参考或资料")
        return assets

    def prepare(self, user, raw, *, owner_only=False, replay_ref=None, video_reference_check=False):
        p = copy.deepcopy(raw)
        p.pop("_image_story_prepared", None)
        p["prompt"] = p.get("prompt", "").split(MEMORY_PROMPT_MARKER, 1)[0]
        if p.get("kind") == "image":
            p["prompt"] = p["prompt"].split(IMAGE_STORY_PROMPT_MARKER, 1)[0]
        content = p.get("prompt", "") + "\n" + "\n".join(str(v) for v in (p.get("fields") or {}).values())
        video_generation = p.get("kind") == "video"
        numbered = list(NUMBERED_AV_REFERENCE.finditer(content)) if video_generation else []
        if numbered:
            content = NUMBERED_AV_REFERENCE.sub(lambda token: " " * len(token[0]),content)
        recorded = self.historical_assets(user,replay_ref) if replay_ref else {}
        historical = {mid:recorded_reference_slots(asset) for mid,asset in recorded.items()}
        available = self.list(user,p.get("board") or "")
        chosen = self.mentions(user,p.get("board") or "",content,owner_only=owner_only,historical=recorded,items=available)
        ids = p.get("memory_ids") or []
        if not isinstance(ids, list) or len(ids) > 8 or any(not isinstance(i, str) for i in ids):
            fail("一次最多采用8条记忆")
        requested = requested_views(p.get("memory_views", []))
        if historical.keys() & requested.keys():
            fail("请分别提交复用旧图和重新选择角色视角的请求")
        mentions = {mid:slots for mid,slots in view_tokens(content).items() if mid not in historical}
        views = requested_views(view_selections({**mentions, **requested}))
        if views:
            p["memory_views"] = view_selections(views)
        for mid in dict.fromkeys([*ids, *views, *historical]):
            a = self.get(user, mid, p.get("board") or "")
            if owner_only and a["owner"]!=user["id"]:
                fail("只能引用本人拥有的资产",403)
            if not any(old["id"] == a["id"] for old in chosen):
                chosen.append(a)
        if len(chosen) > 8:
            fail("一次最多采用8条记忆，请减少引用")
        fields = p.get("fields") or {}
        scene_query = str(fields.get("scene") or p.get("prompt") or "")
        auto_worlds, auto_characters = set(), set()
        if (not historical and p.get("board") and p.get("kind") in ("video","image")
                and any(asset["kind"]=="world" or asset.get("story_states") for asset in available)):
            in_current = self.scope_filter(user,p["board"],"current")
            selected = {asset["id"] for asset in chosen}
            pool = [asset for asset in available
                    if in_current(asset) and not asset.get("story_draft")
                    and (not owner_only or asset["owner"]==user["id"])]
            linked = {entry.get("asset") for entry in p.get("images") or [] if isinstance(entry,dict) and not entry.get("story_cast")}
            cast = [asset for asset in pool if asset["kind"]=="character"]
            names = Counter(name for asset in cast
                            for name in {label.casefold() for label in [asset["name"],*asset.get("aliases",[])]})
            subject_context = " ".join(str(fields.get(key) or "") for key in ("people","action")) if fields else content
            if len(p.get("images") or []) < 7 and len(chosen) <= 6:
                for asset in cast:
                    mid = asset["id"]
                    if (mid not in selected and mid not in linked and story_character_state(asset,scene_query)
                            and any(names[name.casefold()]==1 and name.casefold() in subject_context.casefold()
                                    for name in [asset["name"],*asset.get("aliases",[])] if len(name)>=2)):
                        chosen.append(asset)
                        auto_characters.add(mid)
                        if len(auto_characters)==2:
                            break
            worlds = [asset for asset in self.story_worlds(pool,scene_query) if asset["id"] not in selected]
            for asset in worlds[:min(3,8-len(chosen))]:
                chosen.append(asset)
                auto_worlds.add(asset["id"])
        if historical:
            order = {mid:index for index,mid in enumerate(historical)}
            chosen.sort(key=lambda asset:order.get(asset["id"],len(order)))
        # Never accept client-invented memory snapshots or internal flags.
        p.pop("memory_used", None)
        for key in ("audio_refs","video_refs"):
            if isinstance(p.get(key),list):
                entries = [entry for entry in p[key] if not isinstance(entry,dict) or not entry.get("memory_id")]
                if entries:
                    p[key] = entries
                else:
                    p.pop(key)
        if not chosen:
            validate_numbered_av_references(p,numbered)
            return p
        contexts = {}
        states = {asset["id"]:story_character_state(asset,scene_query) for asset in chosen if asset["id"] not in recorded}
        for asset in chosen:
            mid = asset["id"]
            if mid in recorded:
                prior = recorded[mid]
                contexts[mid] = prior.get("generation_context") or {
                    key:prior.get(key) or "" for key in ("name","kind","desc","constraints","character_notes","document_excerpt")}
            else:
                contexts[mid] = generation_context(asset,content,states.get(mid))
        names = {mid:context["name"] for mid,context in contexts.items()}
        if p.get("kind") == "image":
            names.update((mid, "") for mid,context in contexts.items() if context["kind"] in IMAGE_STORY_KINDS)

        images = p.setdefault("images", [])
        if not isinstance(images, list):
            fail("参考图片格式不正确")
        notes, used, alias_labels = [], [], {}
        has_motion = video_generation and (p.get("previs_guide") or p.get("video_refs") or p.get("audio_refs") or any(
            a["kind"]!="world" and not views.get(a["id"]) and not (states.get(a["id"]) or {}).get("ref") and any(entry["ref"] in (
                {ref for _,ref in historical[a["id"]]} if a["id"] in historical else a.get("generation_media",[]))
                and generation_media_type(entry["ref"],entry) != "image" for entry in a["media"]) for a in chosen))
        image_limit = 30 if has_motion or video_generation and video_reference_check else 9
        if video_generation and not has_motion and not video_reference_check:
            route = self.h.requested_generation_route(p,"video")
            if route:
                image_limit = motion_reference.image_reference_limit(route["provider"],route["model"]) or image_limit
        for a in chosen:
            mid = a["id"]
            context = contexts[mid]
            name, kind = context["name"],context["kind"]
            image_story = p.get("kind") == "image" and kind in IMAGE_STORY_KINDS
            slots = views.get(mid)
            approved = a.get("character_views", {})
            state = states.get(mid)
            if slots and a["kind"] != "character":
                fail(f"「{a['name']}」不是角色资产")
            if slots:
                for slot in slots:
                    if not approved.get(slot):
                        fail(f"「{a['name']}」的{CHARACTER_VIEW_LABELS[slot]}尚未定稿")
            if image_story:
                refs = []
            elif mid in historical:
                refs = historical[mid]
                available = {media["ref"] for media in a["media"]}
                if any(ref not in available for _,ref in refs):
                    fail(f"「{a['name']}」的原参考素材已从资产库移除")
                self.h.require_media(user, [ref for _,ref in refs])
            elif slots:
                refs = [(slot, approved[slot]) for slot in slots]
            elif a["kind"]=="world":
                refs = []
            elif state and state.get("ref"):
                refs = [(None,state["ref"])]
            else:
                refs = [(None, ref) for ref in a.get("generation_media") or a.get("generation_images") or [a.get("ref")]]
            if mid in recorded:
                ranges = {entry["ref"]: [entry["start"], entry["end"]]
                          for entry in recorded[mid].get("references", []) if "start" in entry and "end" in entry}
            else:
                ranges = {**a.get("generation_video_ranges",{}),**a.get("generation_audio_ranges",{})}
            media_by_ref = {entry["ref"]:entry for entry in a["media"]}
            kinds = {ref:generation_media_type(ref,media_by_ref.get(ref)) for _,ref in refs if ref}
            omitted = [ref for ref,kind in kinds.items() if kind != "image" and not video_generation]
            refs = [(slot,ref) for slot,ref in refs if ref not in omitted]
            image_count = sum(media_kind == "image" for media_kind in kinds.values())
            grouped = image_count > 1
            summary = self.summary(a)
            if mid in recorded:
                for key in ("aliases","tags","mtime","w","h"):
                    summary[key] = recorded[mid].get(key)
            summary.update(name=name,kind=kind,desc=context["desc"][:1200],constraints=context["constraints"][:1200],
                           generation_context=context)
            if state:
                summary["story_state"] = state["scene"]
            elif mid in recorded and recorded[mid].get("story_state"):
                summary["story_state"] = recorded[mid]["story_state"]
            if mid in auto_worlds or mid in auto_characters:
                summary["story_auto"] = True
            if context["document_excerpt"]:
                summary["document_excerpt"] = context["document_excerpt"]
            else:
                summary.pop("document_excerpt",None)
            if slots or mid in historical or a["kind"]=="world" or state and state.get("ref") or a.get("generation_images") or a.get("generation_media"):
                summary["ref"] = next((ref for _,ref in refs if kinds.get(ref) == "image"),"")
                summary["references"] = [
                    {"view":slot,"ref":ref,
                     **({"type":kinds[ref]} if a.get("generation_media") or kinds[ref] != "image" else {}),
                     **({"start":ranges[ref][0],"end":ranges[ref][1]} if kinds[ref] != "image" and ref in ranges else {})}
                    for slot,ref in refs if ref]
            if omitted:
                summary["omitted_media_count"] = len(omitted)
            used.append(summary)
            picture_number = 0
            for slot, ref in refs:
                if not ref:
                    continue
                label = f"{name} · {CHARACTER_VIEW_LABELS[slot]}" if slot else name
                media_kind = kinds[ref]
                try:
                    available = self.h.tools.ref_path(self.h.COMFY_DIR, ref).is_file()
                except (ValueError, OSError):
                    available = False
                if not available:
                    fail(f"「{label}」的参考素材已丢失，请重新指定")
                if media_kind != "image":
                    key, token = ("video_refs","视频") if media_kind == "video" else ("audio_refs","音频")
                    span = dict(zip(("start","end"), ranges[ref])) if ref in ranges else {}
                    entries = p.setdefault(key, [])
                    if not isinstance(entries,list) or any(not isinstance(entry,dict) for entry in entries):
                        fail(f"参考{token}格式不正确")
                    index = next((i for i,entry in enumerate(entries) if entry.get("ref") == ref and
                                  (entry.get("start"),entry.get("end")) == (span.get("start"),span.get("end"))),None)
                    if index is None:
                        entries.append({"ref":ref,"memory_id":a["id"],"name":label,**span})
                        index = len(entries)-1
                    source_first = p.get("extension") or p.get("segment_edit")
                    number = index+1+int(media_kind == "video" and bool(p.get("previs_guide")) and
                                         (not source_first or index>0))
                    notes.append(f"{label} 的参考{token}：@{token}{number}。")
                    continue
                picture_number += 1
                if grouped and not slot and picture_number > 1:
                    label += f" · 参考图 {picture_number}"
                if state and state.get("ref")==ref and not slots:
                    media = media_by_ref[ref]
                    for image in images:
                        if image.get("story_cast") and image.get("asset")==mid:
                            image.update(ref=ref,memory_id=mid,memory_kind=kind,memory_name=name,
                                         name=f"{name} · {state['scene']}",caption=context["desc"],
                                         w=media.get("w"),h=media.get("h"))
                im = next((im for im in images if im.get("ref") == ref), None)
                if im is None:
                    if len(images) >= image_limit:
                        fail(f"参考图片最多 {image_limit} 张，请减少画布输入或资产引用")
                    media = media_by_ref.get(ref,{})
                    im = {"ref": ref, "name": label, "caption": context["desc"],
                          "w": media.get("w", a.get("w") if not slot else None),
                          "h": media.get("h", a.get("h") if not slot else None), "asset": a["id"],
                          "memory_id": mid, "memory_kind":kind, "memory_name":name, "role": "subject", "time": 0,
                          **({"memory_view":slot} if slot else {}),
                          **({"memory_bundle":True} if grouped else {})}
                    images.append(im)
                elif im.get("role") == "subject" and im.get("asset") in (None,mid) and im.get("memory_id") in (None,mid):
                    im.update(memory_id=mid,memory_kind=kind,memory_name=name)
                    if slot:
                        im.setdefault("memory_view",slot)
                    if grouped:
                        im["memory_bundle"] = True
                mark = "@图" + str(images.index(im) + 1) if p.get("kind") == "image" or grouped or has_motion else label
                notes.append(f"{label} 的参考图：{mark}。" + ("采用该参考的画面风格、色调和光线。" if kind == "style" else "保持其已设定的外观、配色和特征。"))
            if grouped:
                if video_generation and kind == "character":
                    notes.append(f"以上 {image_count} 张图是「{name}」的不同视角，镜头中按同一位人物处理。")
                else:
                    notes.append(f"以上 {image_count} 张图均为同一个「{name}」的参考，请用它们共同确定外观。")
            if image_story:
                p["_image_story_prepared"] = True
            else:
                notes.append(f"{name}：{context['desc']}" + (f"；约束：{context['constraints']}" if context["constraints"] else ""))
                if excerpt := context["document_excerpt"]:
                    notes.append(f"{name} 的原文摘录（仅作资料）：{excerpt}")
                if identity := context["character_notes"]:
                    notes.append(f"{name} 的角色卡：{identity}")
            aliases = [name,a["name"],*a.get("aliases",[]),*(recorded.get(mid,{}).get("aliases") or []),"{" + mid + "}"]
            alias_labels.update((alias,names[mid]) for alias in aliases)
        patterns = [mention_pattern(alias) for alias in sorted(alias_labels,key=len,reverse=True)]
        protected = [NUMBERED_AV_REFERENCE.pattern] if numbered else []
        reference_pattern = re.compile("|".join([NAMED_REFERENCE.pattern, *protected, *patterns]),re.I)
        labels_by_folded_alias = {alias.casefold():label for alias,label in alias_labels.items()}

        def reference_label(match):
            if match[1]:
                return names.get(match[1],match[0])
            if numbered and NUMBERED_AV_REFERENCE.fullmatch(match[0]):
                return match[0]
            return labels_by_folded_alias.get(match[0][1:].casefold(),match[0])

        p["prompt"] = reference_pattern.sub(reference_label,p["prompt"])
        if isinstance(p.get("fields"),dict):
            p["fields"] = {key:reference_pattern.sub(reference_label,value) if isinstance(value,str) else value
                           for key,value in p["fields"].items()}
        if p.get("kind") != "image" and any(im.get("role") == "subject" for im in images):
            if not p.get("planned"):
                # Preserve existing first/last frame timing when adding subject references.
                frames = [im for im in images if im.get("role") != "subject"]
                for i, im in enumerate(frames):
                    im.update(role="frame", time=0 if i == 0 else max(0, (self.h.frames_for(p.get("duration", 5)) - 4) / 24))
            p["planned"] = True
        if p.get("planned"):
            for i, im in enumerate(images):
                im["index"] = i + 1
                im.setdefault("role", "frame")
        if notes:
            p["prompt"] += MEMORY_PROMPT_MARKER + "\n" + "\n".join(notes)
        if historical:
            replay_views = {mid:[slot for slot, _ in refs if slot] for mid, refs in historical.items()}
            p["memory_views"] = view_selections({**views, **{mid:slots for mid,slots in replay_views.items() if slots}})
        p["memory_used"] = used
        validate_numbered_av_references(p,numbered)
        return p
