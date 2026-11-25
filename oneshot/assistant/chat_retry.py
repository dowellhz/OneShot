"""Validate and replay saved assistant generation requests."""
from __future__ import annotations

import asyncio
import json
import time

from aiohttp import web
import aiohttp

from oneshot.assistant.chat_state import InternalRequest, ToolError
from oneshot.storage import db


class GenerationReplay:
    def validate_retry(self, run, user, snapshot):
        board = self.board(user,run["board_id"])
        pending = snapshot["pending"]
        if generation := snapshot.get("generation"):
            snapshot["generation"] = self.host.prepare_generation_replay(generation,pending.get("prompt"))
        for item in pending.get("batch",[]):
            saved = item["retry_snapshot"]
            recorded = item.get("record",{}).get("prompt", "")
            # Production review truncates prompts to 5000 characters.
            saved["generation"] = self.host.prepare_generation_replay(
                saved["generation"],recorded if isinstance(recorded,str) and len(recorded)<5000 else None)
        if nid := pending.get("target_id"):
            target = next((n for n in board["nodes"] if n["id"] == nid and n["type"] == pending["kind"]),None)
            if not target or target.get("job"):
                raise ToolError("原节点已移除或正在执行任务，无法重试")
        try:
            self.host.require_media(user,snapshot.get("refs",[]))
        except web.HTTPForbidden:
            raise ToolError("已无法访问原任务的参考素材") from None
        refs = self.host.media_references(snapshot.get("generation",{})) | set(snapshot.get("refs",[]))
        if any(not self.host.tools.ref_path(self.host.COMFY_DIR,ref).is_file() for ref in refs):
            raise ToolError("原任务引用的素材或遮罩已丢失，无法重试")

    async def retry_image_set(self, run, user, cid, pending):
        for item in pending["batch"]:
            if self.stopped(run):
                if pending["ids"]:
                    await self.cancel_jobs(run,user,pending["ids"])
                raise ToolError("已停止重试")
            snapshot = item["retry_snapshot"]
            try:
                self.validate_retry(run,user,{**snapshot,"pending":pending})
            except ToolError as error:
                item["error"] = str(error)
                break
            payload = snapshot["generation"]
            if not await self.submit_image_set_item(cid,pending,item,InternalRequest(self,user,payload),payload,retry=True):
                break
        return await self.collect_image_set(run,user,cid,pending)

    async def retry_work(self, run, user):
        rid, sid = run["id"], run["session_id"]
        cid = run["data"]["retry_call"]
        call = db.one("SELECT * FROM chat_calls WHERE id=?",cid)
        saved = json.loads(call["result"]) if call["result"] else None
        snapshot = json.loads(call["args"])
        try:
            if call["state"] == "done":
                result = saved
            elif call["state"] == "waiting":
                result = await self.wait_jobs(run,user,cid,saved)
            elif call["state"] == "submitting" and saved and "batch" in saved:
                result = await self.collect_image_set(run,user,cid,saved)
            elif call["state"] == "submitting":
                raise ToolError("服务在提交重试时中断，请在任务中心核对提交状态")
            else:
                self.validate_retry(run,user,snapshot)
                if self.stopped(run):
                    raise ToolError("已停止重试")
                pending = snapshot["pending"]
                with db.transaction():
                    self.reserve_node_write(run,cid,pending.get("target_id"))
                    self.update(run,"running")
                    db.run("UPDATE chat_calls SET state='submitting',updated=? WHERE id=?",time.time(),cid)
                if "batch" in pending:
                    result = await self.retry_image_set(run,user,cid,pending)
                else:
                    if "generation" in snapshot:
                        payload = {**snapshot["generation"],"count":snapshot["count"]}
                        req = InternalRequest(self,user)
                        response = self.host.submit_prepared_generation(req,payload,fixed_route=snapshot.get("route"),replay=True)
                    else:
                        payload = {**pending["audio_recipe"],"board":run["board_id"],"node":pending.get("target_id"),
                                   "label":pending["name"],"request_key":cid}
                        req = InternalRequest(self,user,payload)
                        req["fixed_audio_model"] = snapshot["audio_model"]
                        response = self.host.generate_audio(req)
                    submitted = await self.read_response(response)
                    recipe = {k:v for k,v in snapshot.items() if k not in ("pending","count","placement")}
                    result = await self.wait_submitted_jobs(run,user,cid,{**pending,"ids":submitted["ids"],"retry_snapshot":recipe})
        except (ToolError, ValueError, TypeError, OSError, aiohttp.ClientError, asyncio.TimeoutError) as e:
            result = {"error":str(e)[:400] or "重试未完成"}
        with db.transaction():
            self.finish_call(run,cid,call["name"],result)
            if self.stopped(run):
                self.update(run,"stopped","已停止")
            elif result.get("error"):
                self.update(run,"error",result["error"])
            else:
                self.update(run,"done")
