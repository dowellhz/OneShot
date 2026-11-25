"""Enforce approval and write reservations for assistant generation."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time

from oneshot.assistant.chat_state import (
    MAX_RUN_SECONDS,
    ToolError,
    dumps,
    ident,
)
from oneshot.assistant.chat_tools import PROMPT
from oneshot.editing import image_camera
from oneshot.editing import image_relight
from oneshot.storage import db


class GenerationApproval:
    async def await_generation_approval(self, run, cid, kind, count, plan, editable, pricing_request, reference_review):
        signature = hashlib.sha256(json.dumps([kind,count,plan],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        exposed = {key:plan[key] for key in ("label","prompt","provider","model","aspect","ar","quality","resolution","duration","mode","voice","placement")
                   if isinstance(plan.get(key),(str,int,float)) and not isinstance(plan.get(key),bool)}
        if kind=="video" and isinstance(plan.get("selected_model"),str):
            exposed["model"] = plan["selected_model"]
        if "prompt" in exposed:
            exposed["prompt"] = str(exposed["prompt"])[:8000]
        if "camera_view" in plan:
            exposed["camera_summary"] = image_camera.instructions(image_camera.validate(plan["camera_view"]))
        if "relight" in plan:
            exposed["light_summary"] = image_relight.instructions(image_relight.validate(plan["relight"]))
        refs = self.host.media_references(plan)
        cost = self.host.generation_unit_cost(pricing_request) if pricing_request is not None else None
        shown = {**exposed,"kind":kind,"count":count,"references":len(refs),"editable":editable,"unit_cost":cost}
        if "items" in plan:
            shown["items"] = plan["items"]
            shown["asset_count"] = len(plan.get("memory_ids",[]))
        approval = db.one("SELECT * FROM chat_approvals WHERE call_id=?",cid)
        previous_plan = json.loads(approval["plan"]) if approval and approval["fingerprint"] == signature else None
        needs_review = reference_review is not None and (
            not (previous_plan or {}).get("reference_checked") or previous_plan.get("editable") != editable)

        async def refresh_references(draft):
            draft.pop("reference_review",None)
            draft.pop("reference_error",None)
            try:
                draft["reference_review"], draft["unit_cost"] = await reference_review(draft.get("overrides",{}))
            except ToolError as error:
                draft["reference_error"] = str(error)
                draft["unit_cost"] = None

        if needs_review:
            changes = (previous_plan or {}).get("overrides",{})
            shown.update(reference_checked=True,overrides=changes)
            await refresh_references(shown)
        with db.transaction():
            if self.stopped(run):
                raise ToolError("用户已停止本轮任务")
            if previous_plan is not None and "editable" not in previous_plan and not needs_review:
                db.run("UPDATE chat_approvals SET plan=? WHERE call_id=?",dumps(shown),cid)
            elif previous_plan is None or previous_plan.get("editable") != editable or needs_review:
                db.run("""INSERT INTO chat_approvals(call_id,id,fingerprint,plan,decision) VALUES(?,?,?,?,NULL)
                       ON CONFLICT(call_id) DO UPDATE SET id=excluded.id,fingerprint=excluded.fingerprint,plan=excluded.plan,decision=NULL""",
                       cid,ident("approval"),signature,dumps(shown))
            db.run("UPDATE chat_calls SET state='approval',updated=? WHERE id=?", time.time(),cid)
            self.update(run,"waiting_approval")
        while not self.stopped(run):
            self.validate_external_task(run,check_board=False)
            if time.time() - run["data"].get("started_at",run["created"]) > MAX_RUN_SECONDS:
                raise ToolError("等待生成确认超时，请重新提交指令")
            approval = db.one("SELECT id,decision,plan FROM chat_approvals WHERE call_id=?",cid)
            stored = json.loads(approval["plan"])
            if approval["decision"] == "approve":
                self.update(run,"running")
                changes = stored.get("overrides",{})
                if stored.get("reference_checked"):
                    changes["_reference_preview"] = (stored.get("reference_review") or {}).get("key")
                return changes
            if approval["decision"] == "skip":
                self.update(run,"running")
                raise ToolError("用户跳过了这次生成，请等待新的修改要求")
            if reference_review and stored.pop("reference_pending",False):
                await refresh_references(stored)
                db.run("UPDATE chat_approvals SET plan=? WHERE id=? AND decision IS NULL",dumps(stored),approval["id"])
            await asyncio.sleep(.2)
        raise ToolError("用户已停止本轮任务")

    def validate_external_task(self, run, *, check_board=True):
        external = run["data"].get("external_tool")
        if not external:
            return
        if not db.one("""SELECT 1 FROM connector_tokens k JOIN users u ON u.id=k.owner
                      WHERE k.id=? AND k.owner=? AND k.expires>? AND u.disabled=0""",
                      external["credential"],run["user_id"],time.time()):
            raise ToolError("外部助手连接已撤销或过期")
        if check_board:
            board = self.host.board_meta(self.host.board_path(run["board_id"]))
            if not board or board.get("owner")!=run["user_id"]:
                raise ToolError("外部助手只能操作本人拥有的画布")

    def reserve_node_write(self, run, cid, node_id):
        if not node_id:
            return
        bid = run["board_id"]
        board = self.board({"id":run["user_id"]},bid)
        target = next((n for n in board["nodes"] if n["id"] == node_id),None)
        if not target:
            raise ToolError("相关节点已移除，任务未提交")
        if target.get("job") and target["job"].get("agent_call") != cid:
            raise ToolError("原节点正在执行其他任务，请等待完成")
        reservation = db.one("SELECT call_id FROM chat_node_writes WHERE board_id=? AND node_id=?",bid,node_id)
        if reservation and reservation["call_id"] != cid:
            raise ToolError("另一个助手正在写入该节点，请稍后重试")
        if not reservation:
            db.run("INSERT INTO chat_node_writes VALUES(?,?,?)",bid,node_id,cid)

    def check_generation_budget(self, run, kind, count):
        if run["data"].get("uncertain"):
            raise ToolError("本轮存在提交状态待核实的任务，已停止追加生成，请先查看任务中心")
        counter, limit = {"video":("generated_video", 1), "previs":("generated_previs", 1), "audio":("generated_audio",1)}.get(kind, ("generated", 4))
        if run["data"].get(counter, 0) + count > limit:
            if kind == "video":
                raise ToolError("每条助手指令最多提交 1 段视频。请把下一段作为新消息发送，当前指令仍在执行时，新消息会加入队列。")
            raise ToolError("本轮生成数量已达上限，请下一轮继续")
        return counter, limit

    def empty_generation_target(self, run, user, kind):
        bound = run["data"].get("empty_target")
        if not bound or bound["kind"] != kind:
            return None
        nid = bound["id"]
        target = next((node for node in self.board(user,run["board_id"])["nodes"] if node["id"] == nid),None)
        if not target or target["type"] != kind or target.get("versions") or target.get("job") or any(
                target.get("data",{}).get(key) for key in ("previs","film","playlist")):
            raise ToolError("指定的空白节点已变化，请重新选择生成目标")
        return nid

    async def begin_generation(self, run, cid, kind, count, plan, *, target_id=None, edit_prompt=False, edit_count=False,
                               force_confirmation=False, pricing_request=None,reference_review=None):
        self.validate_external_task(run)
        counter, limit = self.check_generation_budget(run, kind, count)
        mode = run["data"].get("generation_mode","auto")
        overrides = {}
        if force_confirmation or mode == "manual" or mode == "smart" and (kind != "image" or run["data"].get(counter,0) + count > 2):
            editable = {}
            if edit_prompt:
                editable["prompt"] = PROMPT["maxLength"]
            if edit_count:
                editable["count"] = limit - run["data"].get(counter,0)
            overrides = await self.await_generation_approval(run,cid,kind,count,plan,editable,pricing_request,reference_review)
            if not target_id and plan.get("node"):
                board = self.board({"id":run["user_id"]},run["board_id"])
                if not any(node["id"] == plan["node"] for node in board["nodes"]):
                    raise ToolError("等待确认期间相关节点已移除，生成未提交")
        with db.transaction():
            if self.stopped(run):
                raise ToolError("用户已停止本轮任务")
            self.validate_external_task(run)
            if target_id and run["data"].get("empty_target",{}).get("id")==target_id:
                self.empty_generation_target(run,{"id":run["user_id"]},kind)
            self.reserve_node_write(run,cid,target_id)
            run["data"][counter] = run["data"].get(counter,0) + overrides.get("count",count)
            self.update(run)
            # A crash during submission requires explicit review, never a blind resubmit.
            db.run("UPDATE chat_calls SET state='submitting',updated=? WHERE id=?", time.time(), cid)
        return overrides
