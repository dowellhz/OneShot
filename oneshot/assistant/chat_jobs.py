"""Track generation jobs and record resumable outcomes."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote
import asyncio
import copy
import time

from oneshot.assistant import agent_video
from oneshot.assistant.chat_state import MAX_RUN_SECONDS, ToolError, dumps
from oneshot.editing import audio_separation
from oneshot.storage import db


class JobTracking:
    def stopped(self, run):
        r = db.one("SELECT state FROM chat_runs WHERE id=?", run["id"])
        return not r or r["state"] == "stopping"

    async def cancel_jobs(self, run, user, ids):
        if ids:
            await self.response(self.host.cancel, user, {"ids": ids})

    async def wait_jobs(self, run, user, cid, pending):
        visible = pending.get("target_id") or pending.get("recipe") or pending.get("audio_recipe") or pending.get("broll_source")
        try:
            if visible:
                queued = agent_video.queued_node(self, run, user, cid, pending)
                pending = {**pending, "history": queued.get("history", {})}
            return await self._wait_jobs(run, user, cid, pending)
        except Exception as error:
            if visible:
                agent_video.fail_node(self, run, user, cid, error, pending.get("target_id"))
            raise

    async def _wait_jobs(self, run, user, cid, pending):
        ids = pending["ids"]
        cancel_on_stop = pending.get("cancel_on_stop", True)
        last = None
        for _ in range(1800):
            if time.time() - run["data"].get("started_at",run["created"]) > MAX_RUN_SECONDS:
                if cancel_on_stop:
                    await self.cancel_jobs(run, user, ids)
                    raise ToolError("本轮已达到30分钟执行上限，已尝试取消剩余任务，完成结果仍保留")
                raise ToolError("本轮等待已超时，原任务可在重制工作区查看")
            if self.stopped(run):
                if cancel_on_stop:
                    await self.cancel_jobs(run, user, ids)
                raise ToolError("用户已停止本轮任务")
            states = await self.response(self.host.jobs, user, query={"ids": ",".join(ids)})
            progress = [{"id": i, **{k: states.get(i, {}).get(k) for k in ("state", "phase", "value", "max", "ahead", "error")}} for i in ids]
            key = dumps(progress)
            if key != last:
                self.emit(run["session_id"], run["id"], "progress", {"call_id": cid, "jobs": progress})
                last = key
            if all(states.get(i, {}).get("state") in ("done", "error") for i in ids):
                if separation := pending.get("stem_separation"):
                    return audio_separation.assistant_finish(self,run,user,cid,separation,states[ids[0]])
                if pending.get("remake_export"):
                    return agent_video.finish_remake_export(self, run, user, pending, states[ids[0]])
                if pending.get("remake_generation"):
                    return agent_video.finish_remake_generation(self, run, user, pending["remake_generation"], states)
                if "batch" in pending:
                    return self.finish_image_set(run,user,cid,pending,states)
                versions, errors = [], []
                for jid in ids:
                    s = states[jid]
                    if s["state"] == "error":
                        errors.append(s.get("error") or "生成失败")
                    for out in s.get("outputs") or []:
                        expected = pending.get("kind", "image")
                        suffix = Path(out["ref"]).suffix.lower()
                        allowed = {"video":(".mp4",".mov",".webm",".mkv"),"audio":self.host.tools.AUDIO_EXT,
                                   "image":(".png",".jpg",".jpeg",".webp")}[expected]
                        if suffix not in allowed:
                            errors.append("生成服务返回了不同类型的媒体文件")
                            continue
                        m = out.get("meta") or {}
                        if expected == "video":
                            actual = await asyncio.to_thread(self.host.media_info, self.host.tools.ref_path(self.host.COMFY_DIR, out["ref"]), "video")
                            if not actual.get("width") or not actual.get("height") or not actual.get("duration"):
                                errors.append("结果文件没有可播放的视频流，未按视频保存")
                                continue
                            m = {**m, **actual}
                        if expected == "audio":
                            actual = await asyncio.to_thread(self.host.media_info,self.host.tools.ref_path(self.host.COMFY_DIR,out["ref"]),"audio")
                            if not actual.get("duration"):
                                errors.append("结果文件没有可播放的音轨")
                                continue
                            m = {**m,**actual}
                        metadata = s.get("meta") or {}
                        receipt = copy.deepcopy(pending.get("generation_record"))
                        if receipt is not None:
                            if metadata.get("model"):
                                receipt["settings"]["provider_model"] = metadata["model"]
                            if metadata.get("resolution"):
                                receipt["settings"]["resolution"] = metadata["resolution"]
                            if metadata.get("mode"):
                                receipt["mode"] = metadata["mode"]
                            receipt["service"] = metadata.get("provider") or receipt.get("service")
                            receipt["effective_prompt"] = metadata.get("full_prompt") or metadata.get("prompt") or receipt.get("effective_prompt")
                        versions.append({"ref": out["ref"], "url": "/media?ref=" + quote(out["ref"], safe=""),
                                         "w": m.get("width"), "h": m.get("height"), "seed": (s.get("meta") or {}).get("seed"),
                                         "seconds": m.get("duration"), "prompt": pending["prompt"], "source": pending.get("source", "gen"), "memory_used": pending.get("memory_used", []), **(out.get("extra") or {}),
                                         **({"generation_record":receipt,"mode":metadata.get("mode_name")} if receipt is not None else {}),
                                         **({"audio_recipe":pending["audio_recipe"]} if expected=="audio" else {}),
                                         **({"video_recipe": {**pending["recipe"], "seed": (s.get("meta") or {}).get("seed", pending["recipe"].get("seed", -1))}}
                                            if expected == "video" and pending.get("recipe") else {}),
                                         **(copy.deepcopy(pending.get("history", {})) if expected == "video" else {})})
                result = self.add_results(run, user, cid, versions, pending["name"], pending["prompt"], pending.get("kind", "image"), pending.get("target_id")) if versions else {"nodes": []}
                if pending.get("approval_overrides"):
                    result["approval_overrides"] = pending["approval_overrides"]
                if versions and pending.get("audio_recipe",{}).get("subtitles"):
                    result["text"] = ("配音和同步字幕已放入画布。" if any(v.get("audio_transcript") for v in versions)
                                      else "配音已保存，服务未返回字幕时间码。")
                if pending.get("previs_render") and result["nodes"]:
                    result.update(previs_node=pending["target_id"], text="白模预演已渲染，并保存到原节点的新版本。")
                if pending.get("broll_source") and result["nodes"]:
                    result["text"] = "B-roll 已保存为相连的新视频，原素材保留。"
                if pending.get("source") == "film" and result["nodes"]:
                    recipe = versions[-1]["film_recipe"]
                    result.update(titles=agent_video.timeline_items(recipe.get("titles",[])),
                                  cutaways=agent_video.timeline_items(recipe.get("cutaways",[])),
                                  text="剪辑已保存到原视频节点的新版本，可打开时间线继续编辑。")
                    if pending.get("playlist_node"):
                        result.update(playlist_node=pending["playlist_node"],text="已将成片保存到播放列表的新版本。")
                if errors:
                    result["errors"] = errors
                self.record_retry(run, cid, pending, states)
                if not versions:
                    raise ToolError("；".join(errors) or "任务没有返回有效媒体")
                return result
            await asyncio.sleep(1)
        raise ToolError("等待超时；任务编号已保留，请在任务中心查看，避免重复生成")

    def record_retry(self, run, cid, pending, states):
        snapshot = pending.get("retry_snapshot")
        if not snapshot or self.stopped(run):
            return
        count = sum(self.retryable_job(run,jid,state) for jid,state in states.items() if jid in pending["ids"])
        if not count:
            return
        if pending["kind"] == "image" and len(pending["ids"]) == 1:
            # A provider can produce a multi-image batch under one job ID.
            count = max(count, int(snapshot.get("generation",{}).get("count") or 1))
        recipe = {k:v for k,v in pending.items() if k not in ("ids","history","retry_snapshot")}
        if not recipe.get("target_id") and recipe["kind"] in ("audio","video"):
            recipe["target_id"] = agent_video.result_id(cid)
        retry = {**snapshot,"count":count,"pending":recipe,"placement":run["data"].get("placement")}
        db.run("INSERT OR IGNORE INTO chat_retries(call_id,snapshot) VALUES(?,?)",cid,dumps(retry))

    @staticmethod
    def retryable_job(run, jid, state):
        return (state.get("state")=="error" and not state.get("outputs") and state.get("error")!="已取消"
                and bool(db.one("SELECT 1 FROM tasks WHERE id=? AND user_id=? AND state='error'",jid,run["user_id"])))

    def record_image_set_retry(self, run, cid, pending, states):
        if self.stopped(run):
            return
        items = []
        for item in pending["batch"]:
            jid = item.get("id")
            if item.get("retry_snapshot") and jid in states and self.retryable_job(run,jid,states[jid]):
                fresh = {key:item[key] for key in ("name","aspect","prompt","assets","effective_prompt","record","retry_snapshot") if key in item}
                items.append({**fresh,"state":"unsubmitted"})
        if not items:
            return
        refs = sorted({ref for item in items for ref in item["retry_snapshot"]["refs"]})
        retry = {"count":len(items),"refs":refs,"placement":run["data"].get("placement"),
                 "pending":{**pending,"ids":[],"batch":items}}
        db.run("INSERT OR IGNORE INTO chat_retries(call_id,snapshot) VALUES(?,?)",cid,dumps(retry))

    def finish_call(self, run, cid, name, result):
        db.run("DELETE FROM chat_node_writes WHERE call_id=?",cid)
        db.run("UPDATE chat_calls SET state='done',result=?,updated=? WHERE id=?",dumps(result),time.time(),cid)
        public = {k:v for k,v in result.items() if k not in ("undo","undo_edges")}
        if suggestion := public.get("profile_suggestion"):
            resolved = db.one("SELECT decision FROM assistant_profile_suggestions WHERE call_id=?",cid)
            if resolved and resolved["decision"]:
                public["profile_suggestion"] = {**suggestion,"decision":resolved["decision"]}
        retry = db.one("SELECT json_extract(snapshot,'$.count') AS count FROM chat_retries WHERE call_id=?",cid)
        self.emit(run["session_id"],run["id"],"tool_end",{"call_id":cid,"name":name,"result":public,
                                                        **({"retry_count":retry["count"]} if retry else {})})
        return public

    async def wait_submitted_jobs(self, run, user, cid, pending):
        db.run("UPDATE chat_calls SET state='waiting',result=?,updated=? WHERE id=?", dumps(pending), time.time(), cid)
        self.emit(run["session_id"], run["id"], "submitted", {"call_id": cid, "job_ids": pending["ids"]})
        return await self.wait_jobs(run, user, cid, pending)
