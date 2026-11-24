"""Timed creative events with optional registration and moderated entries."""

import asyncio
import json
import math
import time
from uuid import uuid4

from aiohttp import web

from oneshot.storage import db
from oneshot.canvas import public_canvas
from oneshot.canvas import showcase
from oneshot.editing.render import probe

routes = web.RouteTableDef()
EVENT_ID = r"{eid:e[a-f0-9]{20}}"
WORK_ID = r"{token:[A-Za-z0-9_-]{43}}"
MAX_AWARDS = 20


def response(data, status=200):
    return web.json_response(data,status=status,headers=public_canvas.HEADERS)


def error(message, status=400):
    cls = {400:web.HTTPBadRequest,403:web.HTTPForbidden,404:web.HTTPNotFound,409:web.HTTPConflict}[status]
    raise cls(text=json.dumps({"error":message},ensure_ascii=False),content_type="application/json",
              headers=public_canvas.HEADERS)


async def payload(req):
    body = await req.json()
    if not isinstance(body,dict):
        error("请提交表单信息")
    return body


def field(body, key, limit, required=False):
    value = body.get(key,"")
    if not isinstance(value,str) or len(value.strip()) > limit or required and not value.strip():
        error("请填写完整信息，并检查文字长度")
    return value.strip()


def find_event(eid):
    event = db.one("SELECT * FROM creative_events WHERE id=?",eid)
    if not event:
        error("活动不存在",404)
    event["tracks"] = json.loads(event["tracks"])
    return event


def event_state(event, now, published=False):
    if now < event["starts"]:
        return "upcoming"
    if now < event["closes"]:
        return "open"
    return "ended" if published else "closed"


def require_admin(req):
    if req["user"]["role"] != "admin":
        error("仅管理员可管理活动",403)


@routes.get("/events")
@routes.get("/events/"+EVENT_ID)
async def page(req):
    headers = {**public_canvas.HEADERS,"Content-Security-Policy":
               "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"}
    return web.FileResponse(req.app["creative_events_root"]/"static"/"events.html",headers=headers)


@routes.get("/api/events")
async def listing(req):
    rows = db.q("""SELECT e.id,e.title,e.brief,e.starts,e.closes,e.registration,r.published AS results_at
        FROM creative_events e LEFT JOIN event_results r ON r.event_id=e.id ORDER BY e.starts DESC,e.id LIMIT 100""")
    now = time.time()
    return response([{**row,"state":event_state(row,now,row["results_at"] is not None)} for row in rows])


def published_results(eid):
    result = db.one("SELECT summary,revision,published FROM event_results WHERE event_id=?",eid)
    if result:
        result["awards"] = db.q("""SELECT a.token,a.label,s.title,e.track,
            COALESCE(NULLIF(u.name,''),'OneShot 创作者') AS author
            FROM event_awards a JOIN event_entries e ON e.event_id=a.event_id AND e.token=a.token
            JOIN showcase_entries s ON s.token=e.token JOIN users u ON u.id=e.owner
            WHERE a.event_id=? AND e.state='approved' AND s.state='approved' ORDER BY a.position""",eid)
    return result


@routes.get("/api/events/"+EVENT_ID)
async def detail(req):
    event = find_event(req.match_info["eid"])
    eid = event["id"]
    entries = db.q("""SELECT e.token,e.track,s.title,COALESCE(NULLIF(u.name,''),'OneShot 创作者') AS author
        FROM event_entries e JOIN showcase_entries s ON s.token=e.token JOIN users u ON u.id=e.owner
        WHERE e.event_id=? AND e.state='approved' AND s.state='approved' ORDER BY e.submitted,e.token LIMIT 100""",eid)
    judging = db.one("SELECT criteria,prizes FROM event_judging WHERE event_id=?",eid)
    results = published_results(eid)
    return response({**event,"state":event_state(event,time.time(),results is not None),
                     "entries":entries,"judging":judging,"results":results})


@routes.get("/api/events/"+EVENT_ID+"/me")
async def personal(req):
    event = find_event(req.match_info["eid"])
    owner = req["user"]["id"]
    registration = db.one("SELECT state,reason FROM event_registrations WHERE event_id=? AND owner=?",event["id"],owner)
    entries = db.q("""SELECT e.state,e.reason,e.track,e.token,s.title,s.state AS publication_state,
        CASE WHEN s.state='rejected' THEN s.reason END AS publication_reason FROM event_entries e
        JOIN showcase_entries s ON s.token=e.token WHERE e.event_id=? AND e.owner=? ORDER BY e.submitted DESC""",event["id"],owner)
    works = db.q("""SELECT token,title FROM showcase_entries WHERE owner=? AND state='approved' AND video_ref NOT LIKE '%.gif'
                 ORDER BY published DESC,token LIMIT 100""",owner)
    return response({"registration":registration,"entries":entries,"works":works})


@routes.post("/api/events/"+EVENT_ID+"/registration")
async def register(req):
    event = find_event(req.match_info["eid"])
    if not event["registration"]:
        error("此活动可以直接投稿")
    note = field(await payload(req),"note",1000,required=True)
    owner, now = req["user"]["id"], time.time()
    if now >= event["closes"]:
        error("报名已截止",409)
    db.run("""INSERT INTO event_registrations(event_id,owner,note,state,submitted) VALUES(?,?,?,'pending',?)
        ON CONFLICT(event_id,owner) DO UPDATE SET note=excluded.note,state='pending',reason='',submitted=excluded.submitted
        WHERE event_registrations.state='rejected'""",event["id"],owner,note,now)
    return response(db.one("SELECT state,reason FROM event_registrations WHERE event_id=? AND owner=?",event["id"],owner))


def validate_entry_window(event, track):
    if event_state(event,time.time())!="open":
        error("当前不在投稿时间内",409)
    if track not in (event["tracks"] or [""]):
        error("请选择活动赛道")


def validate_submission(event, owner, track):
    validate_entry_window(event,track)
    if event["registration"] and not db.one("""SELECT 1 FROM event_registrations
                WHERE event_id=? AND owner=? AND state='approved'""",event["id"],owner):
        error("报名审核通过后才能投稿",403)


async def validate_video(event, path):
    if event["min_seconds"] is not None or event["max_seconds"] is not None:
        try:
            if not path:
                raise ValueError("missing video")
            _,_,seconds,_ = await asyncio.to_thread(probe,path,display=False)
        except (OSError,ValueError,IndexError):
            error("无法读取作品时长")
        if (event["min_seconds"] is not None and seconds < event["min_seconds"] or
                event["max_seconds"] is not None and seconds > event["max_seconds"]):
            error("作品时长超出活动要求")


def store_entry(event, owner, token, track):
    validate_submission(event,owner,track)
    existing = db.one("SELECT token,state FROM event_entries WHERE event_id=? AND token=?",event["id"],token)
    if existing and existing["state"]!="rejected":
        return existing,200
    count = db.one("""SELECT count(*) AS n FROM event_entries e JOIN showcase_entries s ON s.token=e.token
        WHERE e.event_id=? AND e.owner=? AND e.token<>? AND e.state<>'rejected' AND s.state<>'rejected'""",
                   event["id"],owner,token)["n"]
    if count>=event["slots"]:
        error("已达到每位创作者的投稿上限",409)
    db.run("""INSERT INTO event_entries(event_id,token,owner,track,state,submitted) VALUES(?,?,?,?,'pending',?)
        ON CONFLICT(event_id,token) DO UPDATE SET track=excluded.track,state='pending',reason='',submitted=excluded.submitted""",
           event["id"],token,owner,track,time.time())
    return {"token":token,"state":"pending"},201


@routes.post("/api/events/"+EVENT_ID+"/entries")
async def submit(req):
    event = find_event(req.match_info["eid"])
    body = await payload(req)
    token, track = field(body,"token",43,required=True), field(body,"track",60)
    validate_entry_window(event,track)
    owner = req["user"]["id"]
    work = db.one("SELECT video_ref FROM showcase_entries WHERE token=? AND owner=? AND state='approved'",token,owner)
    if not work:
        error("请选择自己已发布的作品",404)
    if work["video_ref"].endswith(".gif"):
        error("创作活动投稿需要视频作品",400)
    validate_submission(event,owner,track)
    await validate_video(event,showcase.video_path(req.app["creative_events_media"],work["video_ref"]))
    with db.transaction():
        if not db.one("SELECT 1 FROM showcase_entries WHERE token=? AND owner=? AND state='approved'",token,owner):
            error("请选择自己已发布的作品",404)
        entry,status = store_entry(event,owner,token,track)
    return response(entry,status)


@routes.post("/api/admin/events")
async def create(req):
    require_admin(req)
    body = await payload(req)
    title, brief, rules = (field(body,key,limit,required=True) for key,limit in (("title",120),("brief",1000),("rules",5000)))
    starts, closes, slots, registration = (body.get(key) for key in ("starts","closes","slots","registration"))
    durations = [body.get(key) for key in ("min_seconds","max_seconds")]
    if (not all(type(v) in (int,float) and 0 < v < 253402300799 for v in (starts,closes)) or starts>=closes
            or type(slots) is not int or not 1<=slots<=20 or type(registration) is not bool):
        error("请检查活动时间、投稿名额和报名设置")
    if (any(v is not None and (type(v) not in (int,float) or not math.isfinite(v) or v<=0) for v in durations)
            or all(v is not None for v in durations) and durations[0]>durations[1]):
        error("请填写有效的时长范围")
    tracks = body.get("tracks",[])
    if (not isinstance(tracks,list) or len(tracks)>20 or
            any(not isinstance(t,str) or not 1<=len(t.strip())<=60 for t in tracks)):
        error("最多设置 20 个赛道，每个名称最多 60 字")
    tracks = list(dict.fromkeys(t.strip() for t in tracks))
    eid = "e"+uuid4().hex[:20]
    criteria, prizes = field(body,"criteria",2000), field(body,"prizes",2000)
    with db.transaction():
        db.run("""INSERT INTO creative_events (id,title,brief,rules,starts,closes,slots,registration,tracks,min_seconds,max_seconds)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
               eid,title,brief,rules,starts,closes,slots,int(registration),json.dumps(tracks,ensure_ascii=False),*durations)
        if criteria or prizes:
            db.run("INSERT INTO event_judging VALUES(?,?,?)",eid,criteria,prizes)
    return response({"id":eid},201)


@routes.get("/api/admin/events/"+EVENT_ID+"/results")
async def results_editor(req):
    require_admin(req)
    eid = find_event(req.match_info["eid"])["id"]
    candidates = db.q("""SELECT e.token,e.track,s.title FROM event_entries e
        JOIN showcase_entries s ON s.token=e.token
        WHERE e.event_id=? AND e.state='approved' AND s.state='approved' ORDER BY e.track,e.submitted,e.token""",eid)
    waiting = db.one("""SELECT COUNT(*) AS total,COUNT(CASE WHEN s.state='pending' THEN 1 END) AS showcase
        FROM event_entries e JOIN showcase_entries s ON s.token=e.token WHERE e.event_id=? AND e.state='pending'""",eid)
    return response({"candidates":candidates,"results":published_results(eid),"waiting":waiting,"max_awards":MAX_AWARDS})


@routes.put("/api/admin/events/"+EVENT_ID+"/results")
async def announce_results(req):
    require_admin(req)
    body = await payload(req)
    summary = field(body,"summary",3000,required=True)
    awards, revision = body.get("awards"), body.get("revision")
    if type(revision) is not int or revision<0 or body.get("confirmed") is not True:
        error("请确认公开发布结果")
    if not isinstance(awards,list) or len(awards)>MAX_AWARDS or any(not isinstance(row,dict) for row in awards):
        error(f"最多可公布 {MAX_AWARDS} 项获奖作品")
    awards = [(field(row,"token",43,required=True),field(row,"label",80,required=True)) for row in awards]
    if len({token for token,_ in awards})!=len(awards):
        error("一件作品只能选择一次")
    eid = req.match_info["eid"]
    with db.transaction():
        now = time.time()
        if event_state(find_event(eid),now)!="closed":
            error("投稿截止后才能公布结果",409)
        current = db.one("SELECT revision FROM event_results WHERE event_id=?",eid)
        if revision!=(current["revision"] if current else 0):
            error("结果已更新，请刷新页面后重试",409)
        if db.one("SELECT 1 FROM event_entries WHERE event_id=? AND state='pending'",eid):
            error("还有作品在审核中，请完成审核后再公布结果",409)
        for token,_ in awards:
            if not db.one("""SELECT 1 FROM event_entries e JOIN showcase_entries s ON s.token=e.token
                WHERE e.event_id=? AND e.token=? AND e.state='approved' AND s.state='approved'""",eid,token):
                error("只能选择本活动已通过审核的作品",409)
        db.run("""INSERT INTO event_results VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE
            SET summary=excluded.summary,revision=excluded.revision""",eid,summary,revision+1,now)
        db.run("DELETE FROM event_awards WHERE event_id=?",eid)
        for position,(token,label) in enumerate(awards):
            db.run("INSERT INTO event_awards VALUES(?,?,?,?)",eid,token,label,position)
    return response(published_results(eid))


@routes.get("/api/admin/events/"+EVENT_ID)
async def review_queue(req):
    require_admin(req)
    eid = find_event(req.match_info["eid"])["id"]
    registrations = db.q("""SELECT r.owner,r.note,u.username FROM event_registrations r JOIN users u ON u.id=r.owner
        WHERE r.event_id=? AND r.state='pending' ORDER BY r.submitted LIMIT 100""",eid)
    entries = db.q("""SELECT e.token,e.track,s.title,u.username FROM event_entries e
        JOIN users u ON u.id=e.owner JOIN showcase_entries s ON s.token=e.token
        WHERE e.event_id=? AND e.state='pending' AND s.state='approved' ORDER BY e.submitted LIMIT 100""",eid)
    return response({"registrations":registrations,"entries":entries})


@routes.patch("/api/admin/events/"+EVENT_ID+"/registration/{owner:[0-9]{1,18}}")
@routes.patch("/api/admin/events/"+EVENT_ID+"/entries/"+WORK_ID)
async def review(req):
    require_admin(req)
    body = await payload(req)
    state = body.get("state")
    reason = field(body,"reason",500,required=state=="rejected")
    if state not in ("approved","rejected"):
        error("请选择审核结果")
    eid = find_event(req.match_info["eid"])["id"]
    account = req.match_info.get("owner")
    table, key, target = ("event_registrations","owner",int(account)) if account else (
        "event_entries","token",req.match_info["token"])
    with db.transaction():
        if not account and not db.one("SELECT 1 FROM showcase_entries WHERE token=? AND state='approved'",target):
            error("作品需先通过展映审核",409)
        if not db.one(f"SELECT 1 FROM {table} WHERE event_id=? AND {key}=? AND state='pending'",eid,target):
            error("这条记录已审核或已撤回",409)
        db.run(f"UPDATE {table} SET state=?,reason=? WHERE event_id=? AND {key}=?",state,reason,eid,target)
    return response({"ok":True})


def install(app, root, media):
    app["creative_events_root"] = root
    app["creative_events_media"] = media
    app.add_routes(routes)
