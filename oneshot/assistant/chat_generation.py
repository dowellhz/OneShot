"""Submit assistant generation through the shared generation endpoints."""
from __future__ import annotations

import copy
import json

from aiohttp import web

from oneshot.assistant.chat_state import InternalRequest, ToolError
from oneshot.canvas import workflow_review
from oneshot.memory import creative_memory


class GenerationSubmission:
    async def submit_audio(self, run, user, cid, args):
        nid=self.empty_generation_target(run,user,"audio") or args.get("node_id")
        board=self.board(user,run["board_id"])
        target=next((n for n in board["nodes"] if n["id"]==nid and n["type"]=="audio"),None) if nid else None
        if nid and (not target or target.get("job")):
            raise ToolError("请选择存在且没有生成任务的音频节点")
        keys=("mode","prompt","provider","voice","speed","lyrics","duration_seconds","prompt_influence","loop",
              "subtitles","audio_format","sample_rate","pitch_semitones","gain")
        data=target.get("data",{}) if target else {}
        payload={key:args.get(key,data.get(key)) for key in keys if key in args or key in data}
        if "mode" in args and args["mode"]!=data.get("mode"):
            for key in ("provider","voice"):
                if key not in args:
                    payload.pop(key,None)
        if "provider" in args and args["provider"]!=data.get("provider") and "subtitles" not in args:
            payload.pop("subtitles",None)
        if "audio_format" in args and args["audio_format"]!=data.get("audio_format") and "sample_rate" not in args:
            payload.pop("sample_rate",None)
        payload.setdefault("mode","tts")
        if payload["mode"]=="seed_audio":
            refs = data.get("references") or []
            if "reference_ids" in args:
                refs = []
                for ident in args["reference_ids"]:
                    source = next((n for n in board["nodes"] if n["id"]==ident and n.get("type") in ("image","audio")),None)
                    pinned = run["data"].get("bindings",{}).get(ident)
                    version = (next((v for v in source["versions"] if v.get("ref")==pinned),None) if pinned
                               else self.current(source)) if source else None
                    if not version or not version.get("ref"):
                        raise ToolError("参考素材或所选版本已不存在")
                    refs.append({"node_id":ident,"ref":version["ref"]})
            payload["references"] = refs
        if not (payload.get("prompt") or "").strip():
            raise ToolError("请提供配音文案或声音描述")
        label=args.get("name") or (target["name"] if target else {"tts":"助手配音","music":"助手音乐","sfx":"助手音效",
                                                                "seed_audio":"助手参考音频"}[payload["mode"]])
        changes = await self.begin_generation(run,cid,"audio",1,{**payload,"label":label,"node":nid},target_id=nid,
                                              edit_prompt=True,pricing_request={**payload,"kind":"audio"})
        payload.update(changes)
        request=InternalRequest(self,user,{**payload,"label":label,"board":run["board_id"],"node":nid,"request_key":cid})
        result=await self.read_response(self.host.generate_audio(request))
        recipe=result["recipe"]
        return await self.wait_submitted_jobs(run,user,cid,{
            "ids":result["ids"],"name":label,"prompt":recipe["prompt"],"kind":"audio","target_id":nid,
            **({"approval_overrides":changes} if changes else {}),
            "source":"audio_gen","audio_recipe":recipe,"retry_snapshot":{"audio_model":request.get("generation_model")},
            "generation_record":{"mode":recipe["mode"],"prompt":recipe["prompt"],
            "settings":{k:v for k,v in recipe.items() if k not in ("mode","prompt","references")},
            "inputs":[{"node_id":item["node_id"],"ref":item["ref"],"role":"reference"} for item in recipe.get("references",[])]}})

    async def submit_generation(self, run, user, cid, payload, name, fn, target_id=None, target_data=None, replay_ref=None,
                                composition_ref=None):
        if run["data"].get("uncertain"):
            raise ToolError("本轮存在提交状态待核实的任务，已停止追加生成，请先查看任务中心")
        count = payload.get("count", 1)
        kind = "video" if payload.get("kind") == "video" else "image"
        if target_id:
            target = next((n for n in self.board(user, run["board_id"])["nodes"] if n["id"] == target_id), None)
            if not target or target.get("type") != kind:
                raise ToolError("原节点已不存在或媒体类型不匹配，请重新读取画布")
            if target.get("job"):
                raise ToolError("原节点仍有任务，请等待完成或取消后再修改")
        if fn in (self.host.generate_request, self.host.image_edit_generate):
            payload["memory_ids"] = list(dict.fromkeys([*payload.get("memory_ids", []), *run["data"].get("memory_ids", [])]))
            if views := run["data"].get("memory_views"):
                chosen = creative_memory.requested_views(payload.get("memory_views", []))
                payload["memory_views"] = creative_memory.view_selections({**chosen, **creative_memory.requested_views(views)})
        simple_video = kind == "video" and not replay_ref and not any(payload.get(key) for key in
            ("fields","images","video_refs","audio_refs","previs_guide","camera_plan","object_edit","memory_ids","memory_views"))

        async def inspect_references(changes):
            review_payload = {**payload,"board":run["board_id"],**changes}
            if kind == "image":
                return self.review_image_references(run,user,review_payload)
            request = InternalRequest(self,user,review_payload)
            request["replay_memory_ref"] = replay_ref
            request["connector_own_assets"] = bool(run["data"].get("external_tool"))
            try:
                return await self.host.asset_reference_review(request,review_payload)
            except web.HTTPException as error:
                try:
                    message = json.loads(error.text).get("error")
                except (TypeError,ValueError):
                    message = None
                raise ToolError(message or error.reason) from None

        changes = await self.begin_generation(run,cid,kind,count,{**payload,"label":name,"node":target_id},
                                              target_id=target_id,
                                              edit_prompt=kind == "image" or simple_video,
                                              edit_count=kind == "image" and not target_id and fn == self.host.generate_request,
                                              pricing_request=payload if fn == self.host.generate_request and not replay_ref else None,
                                              reference_review=inspect_references if fn == self.host.generate_request else None)
        reference_reviewed = "_reference_preview" in changes
        reference_preview = changes.pop("_reference_preview",None)
        payload.update(changes)
        if composition_ref:
            target = next((n for n in self.board(user,run["board_id"])["nodes"] if n["id"]==target_id),None)
            current = self.previs_composition(target) if target else None
            if not current or current["ref"]!=composition_ref:
                raise ToolError("白模构图已变更，请重新核对后生成")
        if target_data is not None and "prompt" in changes:
            target_data = {**target_data,"prompt":changes["prompt"],"pmode":"free"}
        payload.update(board=run["board_id"], label=name)
        if reference_reviewed and kind == "image":
            review,_ = self.review_image_references(run,user,payload)
            if (review or {}).get("key") != reference_preview:
                raise ToolError("参考素材或生成服务已变化，请重新确认生成")
        request = InternalRequest(self,user,payload)
        if reference_reviewed and kind == "video":
            request.update(reference_reviewed=True,reference_preview=reference_preview)
        if replay_ref:
            request["replay_memory_ref"] = replay_ref
        if run["data"].get("external_tool"):
            request["connector_own_assets"] = True
        refs = self.host.media_references(payload)
        result = await self.read_response(fn(request,payload) if fn == self.host.generate_request else fn(request))
        if result.get("memory_context"):
            payload.update(result["memory_context"])
        if result.get("reference_context"):
            payload.update(result["reference_context"])
        if result.get("video_model"):
            payload.update(result["video_model"])
            if target_data is not None:
                target_data = {**target_data,**result["video_model"]}
        pending = {"ids": result["ids"], "name": name, "prompt": payload["prompt"], "kind": kind, "memory_used": result.get("memory_used", [])}
        if prepared := request.get("generation_snapshot"):
            refs.update(self.host.media_references(prepared.get("memory_used",[])))
            pending["retry_snapshot"] = {"generation":prepared,"route":request.get("generation_route"),"refs":sorted(refs)}
        if changes:
            pending["approval_overrides"] = changes
        if fn == self.host.generate_request:
            pending["generation_record"] = workflow_review.capture_generation(payload)
        if target_id:
            pending["target_id"] = target_id
        if target_data is not None:
            pending["target_data"] = copy.deepcopy(target_data)
        if kind == "video":
            pending["recipe"] = copy.deepcopy(payload)
        return await self.wait_submitted_jobs(run, user, cid, pending)
