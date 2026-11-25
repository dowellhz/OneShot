"""Handle assistant run approval, retry, cancellation, and undo."""
from __future__ import annotations

import copy
import json
import time

from aiohttp import web

from oneshot.assistant.chat_http import service, session_for
from oneshot.assistant.chat_state import (
    TERMINAL,
    ToolError,
    active_board_runs,
    dumps,
    ident,
    session_waits,
)
from oneshot.assistant.chat_tools import prop, question_items, validate
from oneshot.storage import db


async def retry_call(req):
    session = session_for(req,req.match_info["sid"])
    user = req["user"]
    service_ = service(req)
    cid, sid, bid = req.match_info["cid"], session["id"], session["board_id"]
    with db.transaction():
        retry = db.one("""SELECT x.snapshot,x.retry_run_id,c.name,r.state FROM chat_retries x
                          JOIN chat_calls c ON c.id=x.call_id JOIN chat_runs r ON r.id=c.run_id
                          WHERE c.id=? AND r.session_id=? AND c.state='done'""",cid,sid)
        if not retry:
            return web.json_response({"error":"该任务没有可重试的生成结果"},status=404)
        if retry["retry_run_id"]:
            existing = db.one("SELECT id,state FROM chat_runs WHERE id=?",retry["retry_run_id"])
            return web.json_response(existing)
        if retry["state"] not in TERMINAL or session_waits(sid,active_board_runs(bid)):
            return web.json_response({"error":"请等待当前对话或画布的并行任务空出位置后再重试"},status=409)
        snapshot = json.loads(retry["snapshot"])
        try:
            service_.validate_retry({"board_id":bid},user,snapshot)
        except (ToolError, ValueError, OSError) as e:
            return web.json_response({"error":str(e)},status=409)
        rid, attempt, now = ident("r"), ident("c"), time.time()
        data = {"retry_call":attempt,"bindings":{}}
        if snapshot.get("placement"):
            data["placement"] = snapshot["placement"]
        db.run("INSERT INTO chat_runs VALUES(?,?,?,?,?,?,?,?,?,?)",rid,sid,user["id"],bid,
               "retry_"+cid,"queued",dumps(data),None,now,now)
        db.run("INSERT INTO chat_calls VALUES(?,?,?,?,?,?,?)",attempt,rid,retry["name"],dumps(snapshot),"executing",None,now)
        db.run("UPDATE chat_retries SET retry_run_id=? WHERE call_id=?",rid,cid)
        service_.emit(sid,rid,"retry_queued",{"call_id":cid})
    service_.start_next(bid)
    return web.json_response(db.one("SELECT id,state FROM chat_runs WHERE id=?",rid))


async def decide_generation(req):
    rid, aid = req.match_info["rid"],req.match_info["aid"]
    run = db.one("SELECT session_id FROM chat_runs WHERE id=? AND user_id=?",rid,req["user"]["id"])
    if not run:
        raise web.HTTPNotFound()
    session_for(req,run["session_id"])
    payload = await req.json()
    decision = payload.get("decision") if isinstance(payload,dict) else None
    if decision not in ("approve","skip","adjust"):
        return web.json_response({"error":"请选择确认生成、调整参数或跳过"},status=400)
    with db.transaction():
        row = db.one("""SELECT a.decision,a.plan,c.state AS call_state,r.state AS run_state FROM chat_approvals a
                        JOIN chat_calls c ON c.id=a.call_id JOIN chat_runs r ON r.id=c.run_id
                        WHERE a.id=? AND r.id=?""",aid,rid)
        if row and row["decision"] == decision:
            return web.json_response({"ok":True})
        if not row or row["decision"] or row["call_state"] != "approval" or row["run_state"] != "waiting_approval":
            return web.json_response({"error":"该生成方案已变更或处理完成"},status=409)
        plan = json.loads(row["plan"])
        if decision == "approve" and (plan.get("reference_pending") or plan.get("reference_error")):
            return web.json_response({"error":plan.get("reference_error") or "正在核对生成参考，请稍后再确认"},status=409)
        if decision == "adjust":
            editable, parameters = plan.get("editable",{}), payload.get("parameters")
            if not isinstance(parameters,dict) or not parameters or set(parameters) - editable.keys():
                return web.json_response({"error":"此生成方案不支持调整这些参数"},status=400)
            changes = {}
            if "prompt" in parameters:
                prompt = parameters["prompt"]
                if not isinstance(prompt,str) or not 1 <= len(prompt.strip()) <= editable["prompt"]:
                    return web.json_response({"error":"提示词为空或超过允许长度"},status=400)
                changes["prompt"] = prompt.strip()
            if "count" in parameters:
                count = parameters["count"]
                if type(count) is not int or not 1 <= count <= editable["count"]:
                    return web.json_response({"error":f"数量必须为 1–{editable['count']} 的整数"},status=400)
                changes["count"] = count
            plan["overrides"] = {**plan.get("overrides",{}),**changes}
            asset_prompt_edit = "prompt" in changes and (
                "@" in changes["prompt"] or (plan.get("reference_review") or {}).get("assets") or plan.get("reference_error")
            )
            if plan.get("reference_checked") and (plan.get("kind") != "image" or asset_prompt_edit):
                plan["reference_pending"] = True
                plan.pop("reference_error",None)
                plan["unit_cost"] = None
            revision = ident("approval")
            db.run("UPDATE chat_approvals SET id=?,plan=? WHERE id=?",revision,dumps(plan),aid)
            return web.json_response({"ok":True,"approval_id":revision})
        db.run("UPDATE chat_approvals SET decision=? WHERE id=?",decision,aid)
    return web.json_response({"ok":True})


async def answer_questions(req):
    rid,cid = (req.match_info[key] for key in ("rid","cid"))
    run = db.one("SELECT session_id FROM chat_runs WHERE id=? AND user_id=?",rid,req["user"]["id"])
    if not run:
        raise web.HTTPNotFound()
    session_for(req,run["session_id"])
    payload = await req.json()
    try:
        validate(payload,prop("object",properties={"answers":prop("array",minItems=1,maxItems=4,
            items=prop("string",minLength=1,maxLength=500))},required=["answers"],additionalProperties=False))
        answers = [answer.strip() for answer in payload["answers"]]
        with db.transaction():
            row = db.one("""SELECT c.args,c.result,c.state,r.state AS run_state FROM chat_calls c JOIN chat_runs r ON r.id=c.run_id
                            WHERE c.id=? AND c.run_id=? AND c.name='ask_creative_questions'""",cid,rid)
            if not row:
                raise web.HTTPNotFound()
            questions = question_items(json.loads(row["args"]))
            if len(answers)!=len(questions) or not all(answers):
                raise ToolError("请填写每一项创作确认")
            result = {"answers":[{"question":question["prompt"],"answer":answer} for question,answer in zip(questions,answers)]}
            if row["result"] and result==json.loads(row["result"]):
                return web.json_response({"ok":True})
            if row["result"] or row["run_state"]!="waiting_input" or row["state"]!="question":
                return web.json_response({"error":"这张创作确认卡已处理或过期"},status=409)
            db.run("UPDATE chat_calls SET result=?,updated=? WHERE id=?",dumps(result),time.time(),cid)
            service(req).emit(run["session_id"],rid,"question_answer",{"call_id":cid,**result})
    except ToolError as error:
        return web.json_response({"error":str(error)},status=400)
    return web.json_response({"ok":True})


async def stop_run(req):
    run = db.one("SELECT * FROM chat_runs WHERE id=? AND user_id=?", req.match_info["rid"], req["user"]["id"])
    if not run:
        raise web.HTTPNotFound()
    session_for(req, run["session_id"])
    if run["state"] == "queued":
        return await remove_queued_run(req)
    if run["state"] not in TERMINAL:
        db.run("UPDATE chat_runs SET state='stopping',updated=? WHERE id=?", time.time(), run["id"])
        if run["state"] == "thinking" and not json.loads(run["data"]).get("retry_call") and run["id"] in service(req).tasks:
            service(req).tasks[run["id"]].cancel()
    return web.json_response({"ok": True})


async def remove_queued_run(req):
    rid = req.match_info["rid"]
    run = db.one("SELECT * FROM chat_runs WHERE id=? AND user_id=?",rid,req["user"]["id"])
    if not run:
        raise web.HTTPNotFound()
    session_for(req,run["session_id"])
    with db.transaction():
        current = db.one("SELECT state,data FROM chat_runs WHERE id=?",rid)
        if current["state"] != "queued" or json.loads(current["data"]).get("retry_call"):
            return web.json_response({"error":"该指令已经离开等待队列"},status=409)
        db.run("UPDATE chat_runs SET state='stopped',data=?,updated=? WHERE id=?",
               dumps({"discarded_before_start":True}),time.time(),rid)
    service(req).start_next(run["board_id"])
    return web.json_response({"ok":True})


async def undo_run(req):
    s = service(req)
    run = db.one("SELECT * FROM chat_runs WHERE id=? AND user_id=?", req.match_info["rid"], req["user"]["id"])
    if not run:
        raise web.HTTPNotFound()
    session_for(req, run["session_id"])
    if run["state"] not in TERMINAL:
        return web.json_response({"error": "请先停止或等待本轮完成"}, status=409)
    run["data"] = json.loads(run["data"])
    cid = "undo_" + run["id"]
    try:
        def change(b):
            ops = [o for o in b.get("agent_ops", []) if o.get("run") == run["id"] and not o["id"].startswith("undo_")]
            if not ops:
                raise ToolError("没有可撤销的画布改动，或记录已过期")
            for op in reversed(ops):
                edges = b.setdefault("edges", [])
                for edge in op["result"].get("undo_edges", {}).get("added", []):
                    if edge not in edges:
                        raise ToolError("相关连线后来已被修改，未撤销，以保留后续操作")
                    edges.remove(edge)
                for edge in op["result"].get("undo_edges", {}).get("removed", []):
                    if edge in edges:
                        raise ToolError("相关连线后来已被修改，未撤销")
                    edges.append(copy.deepcopy(edge))
                for nid, pair in op["result"].get("undo", {}).items():
                    current = next((n for n in b["nodes"] if n["id"] == nid), None)
                    if current != pair["after"]:
                        raise ToolError("相关节点后来已被修改，未撤销，以保留后续操作")
                    if pair["before"] is None:
                        if any(e.get("from") == nid or e.get("to") == nid for e in b.get("edges", [])) or any(nid in g.get("nodes", []) for g in b.get("groups", [])):
                            raise ToolError("结果已连线或编组，未撤销，以保留后续操作")
                        b["nodes"].remove(current)
                    else:
                        b["nodes"][b["nodes"].index(current)] = copy.deepcopy(pair["before"])
            return {"undone": True}
        result = s.commit(run, req["user"], cid, change)
        return web.json_response({k: v for k, v in result.items() if k not in ("undo", "undo_edges")})
    except ToolError as e:
        return web.json_response({"error": str(e)}, status=409)
