"""Manage assistant sessions, task history, and saved conversations."""
from __future__ import annotations

import hashlib
import json
import re
import time

from aiohttp import web

from oneshot.assistant import agent_editing
from oneshot.assistant.chat_http import service, session_for
from oneshot.assistant.chat_models import chat_model_option, chat_model_routes, chat_model_session
from oneshot.assistant.chat_state import (
    QUEUED_TASK_FIELDS,
    ToolError,
    dumps,
    ident,
    task_directory_snapshot,
)
from oneshot.assistant.chat_tools import (
    NODE,
    PROMPT,
    prop,
    question_items,
    validate,
)
from oneshot.memory import creative_memory
from oneshot.memory import document_import
from oneshot.storage import db


async def list_sessions(req):
    bid = req.query.get("board", "")
    try:
        service(req).board(req["user"], bid)
    except (ToolError, web.HTTPException) as e:
        return web.json_response({"error": str(e)}, status=403)
    return web.json_response({**task_directory_snapshot(req["user"]["id"],bid),
                              "models": [chat_model_option(route) for route in chat_model_routes().values()]})


async def task_history(req):
    user, bid = req["user"], req.query.get("board", "")
    try:
        service(req).board(user,bid)
    except (ToolError, web.HTTPException) as e:
        return web.json_response({"error": str(e)}, status=403)
    try:
        before = int(req.query.get("before","0"))
        if not 0 <= before <= 2**63-1:
            raise ValueError()
    except ValueError:
        return web.json_response({"error":"游标格式错误"},status=400)
    page_size = 20
    rows = db.q("""SELECT r.rowid AS cursor,r.id,r.session_id,s.title,r.state,
                   (SELECT SUBSTR(json_extract(e.data,'$.text'),1,180) FROM chat_events e
                    WHERE e.run_id=r.id AND e.kind='user' ORDER BY e.id LIMIT 1) AS text
                   FROM chat_runs r JOIN chat_sessions s ON s.id=r.session_id
                   WHERE r.board_id=? AND r.user_id=? AND s.board_id=r.board_id AND s.user_id=r.user_id
                   AND r.state IN ('done','error','stopped') AND json_type(r.data,'$.discarded_before_start') IS NULL
                   AND (?=0 OR r.rowid<?) ORDER BY r.rowid DESC LIMIT ?""",bid,user["id"],before,before,page_size+1)
    page = rows[:page_size]
    more = page[-1]["cursor"] if len(rows)>page_size else None
    for row in page:
        row.pop("cursor")
    return web.json_response({"tasks":page,"before":more})


async def create_session(req):
    p = await req.json()
    try:
        if not isinstance(p, dict):
            raise ToolError("参数须为对象")
        bid = p.get("board", "")
        service(req).board(req["user"], bid)
        sid, now = ident("s"), time.time()
        db.run("INSERT INTO chat_sessions VALUES(?,?,?,?,?,?)", sid, req["user"]["id"], bid, "新对话", now, now)
        return web.json_response({"id": sid})
    except ToolError as e:
        return web.json_response({"error": str(e)}, status=400)


async def start_canvas_from_brief(req):
    svc, user = service(req), req["user"]
    host = svc.host
    try:
        payload = await req.json()
        validate(payload,prop("object",properties={"text":PROMPT,"title":prop("string",maxLength=80),
            "request_key":prop("string",minLength=12,maxLength=100),"project":NODE,"team":NODE},
            required=["text","request_key"],additionalProperties=False))
        key = payload["request_key"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]{12,100}",key):
            raise ToolError("请求编号格式不正确")
        text = payload["text"].strip()
        if not text:
            raise ToolError("请输入创作需求")
        title = payload.get("title","").strip() or next(line.strip() for line in text.splitlines() if line.strip())[:30]
        project, team = payload.get("project"),payload.get("team")
        signature = hashlib.sha256(dumps([text,title,project,team]).encode()).hexdigest()
        with db.transaction():
            receipt = db.one("SELECT * FROM chat_canvas_starts WHERE owner=? AND request_key=?",user["id"],key)
            if receipt and receipt["fingerprint"]!=signature:
                raise ToolError("该请求编号已用于不同的创作需求")
            if not receipt:
                host.validate_canvas_destination(user,project,team)
                receipt = {"board_id":ident("b"),"session_id":ident("s"),"run_id":None}
                db.run("INSERT INTO chat_canvas_starts VALUES(?,?,?,?,?,NULL)",user["id"],key,signature,
                       receipt["board_id"],receipt["session_id"])
        bid,sid,rid = (receipt[field] for field in ("board_id","session_id","run_id"))
        path = host.board_path(bid)
        if rid:
            svc.board(user,bid)
        else:
            host.validate_canvas_destination(user,project,team)
            with db.transaction():
                created = not path.is_file()
                if not created:
                    existing = host.board_meta(path)
                    if (existing.get("owner")!=user["id"] or existing.get("team")!=team or
                            existing.get("name")!=title or existing.get("nodes")):
                        raise ToolError("此创作画布已变化，请从新请求开始")
                try:
                    if created:
                        board = {"name":title,"owner":user["id"],"shared":False,"rev":1,
                                 "nodes":[],"edges":[],"groups":[],"seq":1,"view":{"x":0,"y":0,"k":1}}
                        if team:
                            board["team"] = team
                        host.write_board(path,board)
                    if project:
                        host.assign_canvas_project(bid,project)
                    memory = [a["id"] for a in req.app["creative_memory"].mentions(user,bid,text,strict=True)]
                    now,rid = time.time(),ident("r")
                    turn = {"event":{"text":text,"selected":[]},"content":text}
                    data = {"selected":[],"bindings":{},"generated":0,"generation_mode":"manual",
                            "memory_ids":memory,"explicit_memory_ids":memory,
                            "memory_views":creative_memory.view_selections(creative_memory.view_tokens(text)),
                            "memory_query":text,"node_state":{},"session_id":sid,"queued_turn":turn}
                    db.run("INSERT INTO chat_sessions VALUES(?,?,?,?,?,?)",sid,user["id"],bid,title[:30],now,now)
                    db.run("INSERT INTO chat_runs VALUES(?,?,?,?,?,?,?,?,?,?)",rid,sid,user["id"],bid,key,
                           "queued",dumps(data),None,now,now)
                    db.run("UPDATE chat_canvas_starts SET run_id=? WHERE owner=? AND request_key=?",rid,user["id"],key)
                except BaseException:
                    if created:
                        path.unlink(missing_ok=True)
                    raise
        svc.start_next(bid)
        return web.json_response({"board":bid,"session":sid,"task":rid,
                                  "url":"/?board="+bid+"&session="+sid},status=200 if receipt["run_id"] else 201)
    except (ToolError,ValueError) as error:
        return web.json_response({"error":str(error)},status=400)


async def get_session(req):
    s = session_for(req, req.match_info["sid"])
    try:
        after = max(0, int(req.query.get("after", 0)))
    except ValueError:
        return web.json_response({"error": "游标格式错误"}, status=400)
    events = db.q("SELECT * FROM chat_events WHERE session_id=? AND id>? AND kind!='model' ORDER BY id LIMIT 300", s["id"], after)
    for e in events:
        e["data"] = json.loads(e["data"])
    runs = db.q("""SELECT id,state,error,data,created,updated FROM chat_runs WHERE session_id=? AND state!='queued'
                AND json_type(data,'$.discarded_before_start') IS NULL ORDER BY created DESC LIMIT 20""",s["id"])
    for r in runs:
        data = json.loads(r.pop("data"))
        r["model"] = data.get("model")
    queue = db.q(f"""SELECT {QUEUED_TASK_FIELDS}
                     FROM chat_runs WHERE session_id=? AND state='queued' ORDER BY rowid""",s["id"])
    approvals = db.q("""SELECT a.id,a.plan,c.name,r.id AS run_id FROM chat_approvals a
                        JOIN chat_calls c ON c.id=a.call_id JOIN chat_runs r ON r.id=c.run_id
                        WHERE r.session_id=? AND r.state='waiting_approval' AND c.state='approval' AND a.decision IS NULL""",s["id"])
    for approval in approvals:
        plan = json.loads(approval["plan"])
        overrides = plan.pop("overrides",{})
        plan.pop("reference_checked",None)
        if plan.get("reference_pending") or plan.get("reference_error"):
            plan.pop("reference_review",None)
        elif review := plan.get("reference_review"):
            review.pop("key",None)
        approval["plan"] = {**plan,**overrides}
    level = db.one("""SELECT json_extract(data,'$.thinking_level') AS level FROM chat_runs
                      WHERE session_id=? AND json_type(data,'$.chat_model') IS NOT NULL ORDER BY rowid DESC LIMIT 1""",s["id"])
    questionnaires = db.q("""SELECT c.id,c.run_id,c.args FROM chat_calls c JOIN chat_runs r ON r.id=c.run_id
                         WHERE r.session_id=? AND r.state='waiting_input' AND c.state='question' AND c.result IS NULL""",s["id"])
    svc = service(req)
    previews = [svc.reply_previews[r["id"]] for r in reversed(runs) if r["state"]=="thinking" and r["id"] in svc.reply_previews]
    return web.json_response({"session": s, "events": events, "runs": runs, "queue":queue,"inputs": agent_editing.pending_inputs(s["id"]),"approvals":approvals,
                              "reply_previews":previews if len(events)<300 else [],
                              "questionnaires":[{"id":row["id"],"run_id":row["run_id"],"questions":question_items(json.loads(row["args"]))}
                                                for row in questionnaires],
                              "model_options":[chat_model_option(route) for route in chat_model_routes().values()],
                              "chat_model":chat_model_session(s["id"]),"thinking_level":level["level"] if level else "off",
                              **task_directory_snapshot(req["user"]["id"],s["board_id"]),
                              "board_rev": svc.board(req["user"], s["board_id"]).get("rev", 0)})


async def save_session_memory(req):
    session = session_for(req,req.match_info["sid"])
    rows = db.q("""SELECT id,kind,json_extract(data,'$.text') AS text FROM chat_events
                   WHERE session_id=? AND kind IN ('user','assistant')
                     AND json_type(data,'$.text')='text' AND length(trim(json_extract(data,'$.text')))>0
                   ORDER BY id DESC LIMIT 301""",session["id"])
    rows = [row for row in rows if row["text"].strip()]
    if not rows:
        raise web.HTTPBadRequest(text=json.dumps({"error":"对话还没有可收录的文字消息"},ensure_ascii=False),
                                 content_type="application/json")
    messages, truncated = [], False
    remaining = document_import.MAX_TEXT
    for row in rows[:300]:
        label = "用户" if row["kind"]=="user" else "助手"
        message = f"{label}\n{row['text'].strip()}"
        if len(message)>remaining and messages:
            break
        truncated = truncated or len(message)>remaining
        messages.append(message[:remaining])
        remaining -= len(messages[-1])+2
        if remaining<=0:
            break
    truncated = truncated or len(messages)<len(rows)
    document = {"name":session["title"] or "创作对话","format":"plain",
                "text":"\n\n".join(reversed(messages)),"truncated":truncated}
    asset = req.app["creative_memory"].save_conversation(req["user"],session,document,rows[0]["id"],len(messages))
    return web.json_response({"id":asset["id"],"name":asset["name"],"messages":asset["conversation_source"]["messages"],
                              "truncated":asset["document"]["truncated"]})
