"""Account-scoped Streamable HTTP connector for external creative assistants."""
import asyncio
import hashlib
import json
import re
import secrets
import time
from urllib.parse import urlencode, urlsplit

from aiohttp import web

from oneshot.assistant import agent_chat as chat
from oneshot.canvas import public_canvas
from oneshot.editing import image_editor
from oneshot.integrations.mcp_media import Preview, build_preview
from oneshot.memory import creative_memory
from oneshot.storage import db
from oneshot.web import auth

routes = web.RouteTableDef()
VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26")
SECRET = re.compile(r"osm_[A-Za-z0-9_-]{43}")
REQUEST_KEY = re.compile(r"[A-Za-z0-9_.-]{12,100}")
HEADERS = {"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"}
TOKEN_LIFETIME = 30 * 86400
MAX_TOKENS = 12
prop = chat.prop
BOARD = prop("string",minLength=1,maxLength=40)
KEY = prop("string",minLength=12,maxLength=100)
LIMIT = prop("integer",minimum=1,maximum=100)
MEDIA_VERSION = prop("integer",minimum=1,maximum=5000)
PREVIEW_OPTIONS = {
    "times":prop("array",items=prop("number",minimum=0,maximum=604800),minItems=1,maxItems=4),
    "max_side":prop("integer",minimum=128,maximum=1024),
}
GENERATION = {
    "request_image": ("image_generate", ["prompt","reference_ids","count","aspect","name"]),
    "request_video": ("video_generate", ["prompt","frames","duration","quality","name"]),
}
RESIZE_TOOL = "resize_canvas_image"
IMAGE_SET_TOOL = "request_image_set"
TASK_TOOLS = {**GENERATION, RESIZE_TOOL:("image_transform",["node_id","resize"]),
              IMAGE_SET_TOOL:("image_generate_set",["name","style","aspect","reference_ids","items"])}
TOOLS = {}


def tool(name, description, properties, required=(), *, read_only=False, open_world=False):
    TOOLS[name] = {
        "name":name,"description":description,
        "inputSchema":prop("object",properties=properties,required=list(required),additionalProperties=False),
        "annotations":{"readOnlyHint":read_only,"destructiveHint":False,"openWorldHint":open_world},
    }


tool("list_canvases","列出当前账号拥有的画布，返回真实编号和打开链接。",
     {"query":prop("string",maxLength=120),"limit":LIMIT},read_only=True)
tool("get_canvas","读取本人画布中的节点、当前版本和历史版本编号。",
     {"board":BOARD},["board"],read_only=True)
tool("search_assets","按名称、标签、类别或个人文件夹搜索素材。提供画布可缩小到该画布可用的本人素材。",
     {"board":BOARD,"query":prop("string",maxLength=240),"kind":prop("string",maxLength=30),
      "folder_id":chat.NODE,"limit":LIMIT},read_only=True)
tool("save_canvas_asset","将本人画布的指定媒体版本或文本节点收录到个人资产库。媒体必须给出版本编号；相同 request_key 用于网络重试。",
     {"board":BOARD,"node_id":chat.NODE,"version":prop("integer",minimum=1,maximum=5000),
      "folder_id":chat.NODE,"request_key":KEY},["board","node_id","request_key"])
tool("get_generation","查询外部助手提交的生成或尺寸适配。生成需要用户在画布确认；完成后返回画布节点和版本。",
     {"task_id":chat.NODE},["task_id"],read_only=True)
tool("preview_canvas_media","查看本人画布的指定图片或视频版本。视频可提供最多四个取帧时间（秒），省略时看首帧。",
     {"board":BOARD,"node_id":chat.NODE,"version":MEDIA_VERSION,**PREVIEW_OPTIONS},
     ["board","node_id","version"],read_only=True)
tool("preview_asset","查看本人资产的图片或视频。省略 version 时预览资产默认素材。视频可按秒取帧。",
     {"board":BOARD,"asset_id":chat.NODE,"version":MEDIA_VERSION,**PREVIEW_OPTIONS},
     ["asset_id"],read_only=True)
tool(RESIZE_TOOL,"把指定图片版本缩放到精确像素尺寸，输出作为原节点的新版本。支持透明补边、居中裁切和拉伸。"
     "尺寸适配无需调用生成模型；使用相同 request_key 可安全重试。",
     {"board":BOARD,"node_id":chat.NODE,"version":MEDIA_VERSION,"request_key":KEY,
      "resize":chat.TOOL_MAP["image_transform"]["parameters"]["properties"]["resize"]},
     ["board","node_id","version","request_key","resize"])
for name,(inner,fields) in GENERATION.items():
    properties = chat.TOOL_MAP[inner]["parameters"]["properties"]
    tool(name,"请求生成"+("图片" if name=="request_image" else "视频")+"。用户须在画布中确认；使用相同 request_key 可安全重试。",
         {**{key:properties[key] for key in fields},"board":BOARD,"request_key":KEY,
          "asset_ids":prop("array",items=chat.NODE,maxItems=8)},["board","request_key","prompt"],open_world=True)
tool(IMAGE_SET_TOOL,"一次请求 2–4 张共享风格和参考图的不同图片。按顺序填商品白底、场景、角度、细节图，或逐页填写演示文稿插图。用户在画布确认整组后才会生成。",
     {**chat.TOOL_MAP["image_generate_set"]["parameters"]["properties"],"board":BOARD,"request_key":KEY,
      "asset_ids":prop("array",items=chat.NODE,maxItems=8)},["board","request_key","items"],open_world=True)


def reply(value, status=200, extra=None):
    return web.json_response(value,status=status,headers={**HEADERS,**(extra or {})})


def rpc_error(code, message, identifier=None, status=200):
    return reply({"jsonrpc":"2.0","id":identifier,"error":{"code":code,"message":message}},status)


def digest(secret):
    return hashlib.sha256(secret.encode()).hexdigest()


def check_origin(req):
    origin = req.headers.get("Origin")
    if origin is not None:
        try:
            parsed = urlsplit(origin)
        except ValueError:
            raise web.HTTPForbidden() from None
        if parsed.scheme not in ("https","http") or parsed.netloc != req.host or (
                parsed.path or parsed.query or parsed.fragment):
            raise web.HTTPForbidden()
    if req.headers.get("Sec-Fetch-Site") in ("cross-site","same-site"):
        raise web.HTTPForbidden()


@routes.get("/connect-agents")
async def page(req):
    return web.FileResponse(req.app["connector_root"]/"static"/"connect-agents.html",headers={
        **HEADERS,"Content-Security-Policy":"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    })


@routes.get("/api/connector/tokens")
async def list_tokens(req):
    rows = db.q("""SELECT k.id,k.label,k.created,k.expires,g.token_id IS NOT NULL AS oauth
        FROM connector_tokens k LEFT JOIN connector_oauth_grants g ON g.token_id=k.id
        WHERE k.owner=? AND k.expires>? ORDER BY k.created DESC""",req["user"]["id"],time.time())
    return reply(rows)


@routes.post("/api/connector/tokens")
async def new_token(req):
    check_origin(req)
    if req.content_type!="application/json":
        return auth.err(415,"请求格式不正确")
    try:
        body = await req.json()
    except (ValueError,UnicodeError):
        return auth.err(400,"请求格式不正确")
    label = body.get("label") if isinstance(body,dict) else None
    if not isinstance(label,str) or not 1<=len(label.strip())<=60:
        return auth.err(400,"请输入 1–60 字的连接名称")
    uid, now = req["user"]["id"], time.time()
    token, tid = "osm_"+secrets.token_urlsafe(32), chat.ident("k")
    with db.transaction():
        if db.one("SELECT count(*) AS n FROM connector_tokens WHERE owner=? AND expires>?",uid,now)["n"]>=MAX_TOKENS:
            return auth.err(409,"连接数量已达上限")
        db.run("INSERT INTO connector_tokens VALUES(?,?,?,?,?,?)",tid,uid,label.strip(),digest(token),now,now+TOKEN_LIFETIME)
    return reply({"id":tid,"label":label.strip(),"token":token,"created":now,"expires":now+TOKEN_LIFETIME},201)


@routes.delete(r"/api/connector/tokens/{tid:k[a-f0-9]{20}}")
async def revoke_token(req):
    check_origin(req)
    db.run("DELETE FROM connector_tokens WHERE id=? AND owner=?",req.match_info["tid"],req["user"]["id"])
    return reply({"ok":True})


def credential(req):
    authorization = req.headers.get("Authorization","")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower()!="bearer" or SECRET.fullmatch(token) is None:
        return None, None
    now = time.time()
    resource_url = req.app.get("connector_oauth_resource")
    resource = resource_url(req) if resource_url else None
    row = db.one("""SELECT k.id,u.id AS owner,u.name FROM connector_tokens k JOIN users u ON u.id=k.owner
        LEFT JOIN connector_oauth_grants g ON g.token_id=k.id
        WHERE k.digest=? AND k.expires>? AND u.disabled=0
        AND (g.token_id IS NULL OR g.resource=? AND g.access_expires>?)""",digest(token),now,resource,now)
    if not row:
        return None, None
    return row["id"],{"id":row["owner"],"name":row["name"],"role":"member"}


def canvas_link(bid, session=None):
    return "/?"+urlencode({"board":bid,**({"session":session} if session else {})})


def owned_board(service, user, bid):
    try:
        board = service.board(user,bid)
    except chat.ToolError:
        raise chat.ToolError("找不到本人拥有的画布") from None
    if board.get("owner")!=user["id"]:
        raise chat.ToolError("找不到本人拥有的画布")
    return board


def canvas_version(board, node_id, version):
    node = next((node for node in board.get("nodes",[]) if node["id"]==node_id),None)
    versions = node.get("versions",[]) if node else []
    if not 1<=version<=len(versions) or not versions[version-1].get("ref"):
        raise chat.ToolError("找不到所选画布素材版本")
    return node,versions[version-1]


async def media_preview(req, user, tid, ref, kind, args, identity):
    service = req.app["agent_chat"]
    root = service.host.COMFY_DIR
    if kind not in ("image","video"):
        raise chat.ToolError("请选择图片或视频素材")
    service.host.require_media(user,[ref])
    async with req.app["connector_preview_slots"]:
        result = await asyncio.to_thread(build_preview,root,ref,kind,args.get("times",[]),args.get("max_side",768))
    if not db.one("SELECT 1 FROM connector_tokens k JOIN users u ON u.id=k.owner WHERE k.id=? AND k.expires>? AND u.disabled=0",
                  tid,time.time()):
        raise chat.ToolError("外部助手连接已撤销或过期")
    bid = args.get("board")
    if "node_id" in identity:
        _, version = canvas_version(owned_board(service,user,bid),identity["node_id"],identity["version"])
        if version["ref"]!=ref:
            raise chat.ToolError("所选版本已改变，请重新选择")
    else:
        asset = req.app["creative_memory"].get(user,identity["asset_id"],bid)
        current = asset_media_ref(asset,identity["version"])
        if asset["owner"]!=user["id"] or current!=ref:
            raise chat.ToolError("所选资产已改变，请重新选择")
    service.host.require_media(user,[ref])
    result.summary.update(identity)
    return result


def asset_media_ref(asset, version):
    if version is None:
        return asset.get("ref")
    items = asset.get("media",[])
    return items[version-1].get("ref") if version<=len(items) else None


def generation_status(service, user, tid, rid):
    row = db.one("""SELECT r.id,r.board_id,r.session_id,r.state,r.error,c.state AS call_state,c.result
        FROM connector_runs k JOIN chat_runs r ON r.id=k.run_id
        LEFT JOIN chat_calls c ON c.run_id=r.id WHERE k.token_id=? AND r.id=? AND r.user_id=?""",tid,rid,user["id"])
    if not row:
        raise chat.ToolError("找不到这个连接提交的生成任务")
    board = owned_board(service,user,row["board_id"])
    result = {"task_id":row["id"],"state":row["state"],
              "canvas_url":canvas_link(row["board_id"],row["session_id"])}
    if row["state"]=="waiting_approval":
        result["message"] = "请在 OneShot 打开画布链接并确认生成。"
    if row["error"]:
        result["error"] = row["error"]
    if row["call_state"]=="done" and row["result"]:
        value = json.loads(row["result"])
        nodes = {node["id"]:node for node in board.get("nodes",[])}
        result["nodes"] = []
        for saved in value.get("nodes",[]):
            entry = {key:saved[key] for key in ("id","type","name") if key in saved}
            versions = nodes.get(saved["id"],{}).get("versions",[])
            match = next(((index,item) for index,item in enumerate(versions) if item.get("ref")==saved["ref"]),None)
            if match:
                index,item = match
                entry.update(url=saved["url"],version=index+1,version_index=index)
                entry.update({name:item[key] for name,key in (("width","w"),("height","h"),("duration","seconds")) if key in item})
            else:
                entry["available"] = False
            result["nodes"].append(entry)
        if value.get("errors"):
            result["errors"] = value["errors"]
        if value.get("batch"):
            result["batch"] = value["batch"]
    return result


def request_key(value):
    if not REQUEST_KEY.fullmatch(value):
        raise chat.ToolError("请求编号只能包含字母、数字、点、下划线和连字符")
    return value


def queue_canvas_task(req, user, tid, name, arguments):
    service = req.app["agent_chat"]
    inner, fields = TASK_TOOLS[name]
    bid, key = arguments["board"],request_key(arguments["request_key"])
    args = {field:arguments[field] for field in fields if field in arguments}
    resizing = name==RESIZE_TOOL
    if resizing:
        args["resize"] = image_editor.resize_spec(args["resize"])
        prompt = "尺寸适配 %d×%d"%(args["resize"]["width"],args["resize"]["height"])
    elif name==IMAGE_SET_TOOL:
        if any(not item["name"].strip() or not item["prompt"].strip() for item in args["items"]):
            raise chat.ToolError("每张图都需要名称和提示词")
        prompt = args.get("name","").strip() or "图片套图"
    else:
        args["prompt"] = prompt = args["prompt"].strip()
        if not prompt:
            raise chat.ToolError("请提供生成提示词")
    board = owned_board(service,user,bid)
    asset_ids = list(dict.fromkeys(arguments.get("asset_ids",[])))
    request = [name,bid,args,asset_ids]
    if resizing:
        request.append(arguments["version"])
    signature = digest(json.dumps(request,sort_keys=True,ensure_ascii=False,allow_nan=False))
    prior = db.one("SELECT signature,run_id FROM connector_runs WHERE token_id=? AND request_key=?",tid,key)
    if prior:
        if prior["signature"]!=signature:
            raise chat.ToolError("该请求编号已用于不同生成，请使用新的请求编号")
        return generation_status(service,user,tid,prior["run_id"])
    memory = req.app["creative_memory"]
    for aid in asset_ids:
        if memory.get(user,aid,bid)["owner"]!=user["id"]:
            raise chat.ToolError("只能引用本人拥有的资产")
    selected = [args["node_id"]] if resizing else list(dict.fromkeys([
        *args.get("reference_ids",[]),*(frame["node_id"] for frame in args.get("frames",[]))]))
    nodes = {node["id"]:node for node in board.get("nodes",[])}
    refs = {}
    for nid in selected:
        if resizing:
            node,current = canvas_version(board,nid,arguments["version"])
        else:
            node = nodes.get(nid)
            current = service.current(node) if node else None
        if not current or not current.get("ref") or node.get("type")!="image":
            raise chat.ToolError("请选择画布中已有内容的图片节点")
        refs[nid] = current["ref"]
    now, rid = time.time(),chat.ident("r")
    sid = "s"+digest(f"connector:{tid}:{bid}")[:20]
    data = {"selected":selected,"bindings":refs,"generation_mode":"manual","memory_ids":asset_ids,
            "refresh_context":True,"node_state":{},"external_tool":{"credential":tid,"name":inner,"args":args},
            "queued_turn":{"event":{"text":prompt,"selected":selected},"content":prompt}}
    with db.transaction():
        if db.one("SELECT count(*) AS n FROM chat_runs WHERE board_id=? AND state='queued'",bid)["n"]>=chat.MAX_QUEUED_RUNS:
            raise chat.ToolError("画布队列已满，请稍后重试")
        db.run("INSERT OR IGNORE INTO chat_sessions VALUES(?,?,?,?,?,?)",sid,user["id"],bid,"外部助手",now,now)
        db.run("INSERT INTO chat_runs VALUES(?,?,?,?,?,?,?,?,?,?)",rid,sid,user["id"],bid,key,"queued",chat.dumps(data),None,now,now)
        db.run("INSERT INTO connector_runs VALUES(?,?,?,?)",tid,key,signature,rid)
    service.start_next(bid)
    return generation_status(service,user,tid,rid)


async def run_tool(req, user, tid, name, args):
    service = req.app["agent_chat"]
    if name in TASK_TOOLS:
        return queue_canvas_task(req,user,tid,name,args)
    if name=="get_generation":
        return generation_status(service,user,tid,args["task_id"])
    limit = args.get("limit",30)
    query = args.get("query","").strip()
    bid = args.get("board")
    if name=="list_canvases":
        items = []
        for path in sorted(service.host.BOARDS.glob("*.json"),key=lambda file:-file.stat().st_mtime):
            board = service.host.board_meta(path)
            if not board or board.get("owner")!=user["id"] or query.casefold() not in (board.get("name") or "").casefold():
                continue
            items.append({"id":path.stem,"name":board.get("name"),"url":canvas_link(path.stem)})
            if len(items)>=limit:
                break
        return {"canvases":items}
    board = owned_board(service,user,bid) if bid else None
    if name=="preview_canvas_media":
        node, version = canvas_version(board,args["node_id"],args["version"])
        return await media_preview(req,user,tid,version["ref"],node["type"],args,
                                   {"canvas_url":canvas_link(bid),"node_id":node["id"],"version":args["version"]})
    if name=="preview_asset":
        asset = req.app["creative_memory"].get(user,args["asset_id"],bid)
        if asset["owner"]!=user["id"]:
            raise chat.ToolError("只能预览本人拥有的资产")
        version = args.get("version")
        ref = asset_media_ref(asset,version)
        if not ref:
            raise chat.ToolError("找不到资产的所选素材")
        kind = "video" if public_canvas.media_path(service.host.COMFY_DIR,ref,"video") else "image"
        return await media_preview(req,user,tid,ref,kind,args,{"asset_id":asset["id"],"version":version})
    if name=="get_canvas":
        return {"id":bid,"name":board.get("name"),"url":canvas_link(bid),"nodes":[
            {"id":node["id"],"name":node.get("name"),"type":node.get("type"),"current_version":node.get("cur",-1)+1,
             "versions":[{"version":i,"width":v.get("w"),"height":v.get("h"),"duration":v.get("seconds")}
                         for i,v in enumerate(node.get("versions",[]),1)]} for node in board.get("nodes",[])[:150]]}
    if name=="search_assets":
        memory = req.app["creative_memory"]
        folders = db.q("SELECT id,name FROM asset_folders WHERE owner=? ORDER BY name",user["id"])
        membership = {row["asset_id"]:row["folder_id"] for row in db.q(
            "SELECT asset_id,folder_id FROM asset_folder_items WHERE owner=?",user["id"])}
        items = [dict(id=a["id"],name=a["name"],kind=a["kind"],tags=a.get("tags",[]),
                      description=a.get("desc","")[:350],folder_id=membership.get(a["id"]))
                 for a in memory.list(user,bid,query,args.get("kind")) if a["owner"]==user["id"] and (
                     "folder_id" not in args or args["folder_id"]==membership.get(a["id"]))]
        return {"assets":items[:limit],"folders":folders}
    if name=="save_canvas_asset":
        node = next((node for node in board.get("nodes",[]) if node["id"]==args["node_id"]),None)
        if not node:
            raise chat.ToolError("找不到画布节点")
        versions = node.get("versions",[])
        index = args.get("version",0)-1
        version = versions[index] if 0<=index<len(versions) else None
        if not version and (node.get("type")!="text" or "version" in args):
            raise chat.ToolError("找不到可收录的版本")
        payload = {"board":bid,"scope":"personal","folder":args.get("folder_id"),
                   "request_key":request_key(args["request_key"]),"nodes":[{"id":node["id"],"ref":(version or {}).get("ref")}]}
        saved = await service.response(creative_memory.import_canvas_assets,user,payload)
        return {"asset_ids":saved["ids"]}
    raise chat.ToolError("工具不存在")


@routes.route("*","/mcp")
async def protocol(req):
    # This endpoint serves programmatic HTTPS/LAN clients, not browser JS origins.
    if "Origin" in req.headers:
        return rpc_error(-32000,"Origin is not allowed",status=403)
    tid,user = credential(req)
    if not user:
        challenge = req.app.get("connector_oauth_challenge")
        return reply({"error":"A valid OneShot connector Bearer token is required"},401,
                     {"WWW-Authenticate":challenge(req) if challenge else "Bearer"})
    if req.method!="POST":
        return web.Response(status=405,headers={**HEADERS,"Allow":"POST"})
    if req.content_type!="application/json":
        return rpc_error(-32600,"Expected application/json",status=415)
    accepted = {part.split(";",1)[0].strip() for part in req.headers.get("Accept","*/*").split(",")}
    if accepted.isdisjoint({"application/json","application/*","*/*"}):
        return rpc_error(-32600,"Accept must include application/json",status=406)
    if req.headers.get("MCP-Protocol-Version","2025-03-26") not in VERSIONS:
        return rpc_error(-32600,"Unsupported MCP protocol version",status=400)
    raw = bytearray()
    async for chunk in req.content.iter_chunked(8192):
        raw.extend(chunk)
        if len(raw)>65536:
            return rpc_error(-32600,"Request too large",status=413)
    try:
        message = json.loads(raw)
    except (ValueError,UnicodeError,RecursionError):
        return rpc_error(-32700,"Parse error",status=400)
    if not isinstance(message,dict) or message.get("jsonrpc")!="2.0":
        return rpc_error(-32600,"Invalid request",status=400)
    method, identifier = message.get("method"),message.get("id")
    if "id" not in message and isinstance(method,str) and method.startswith("notifications/"):
        return web.Response(status=202,headers=HEADERS)
    if type(identifier) not in (str,int) or not isinstance(method,str):
        return rpc_error(-32600,"Invalid request",status=400)
    params = message.get("params",{})
    if not isinstance(params,dict):
        return rpc_error(-32602,"Invalid params",identifier)
    if method=="initialize":
        chosen = params.get("protocolVersion")
        if not isinstance(chosen,str):
            return rpc_error(-32602,"Expected protocolVersion",identifier)
        result = {"protocolVersion":chosen if chosen in VERSIONS else VERSIONS[0],
                  "serverInfo":{"name":"OneShot","version":"1.0.0"},"capabilities":{"tools":{"listChanged":False}},
                  "instructions":"生成需要用户在 OneShot 确认。把 canvas_url 解析成相对于 MCP 服务地址的完整链接并发给用户，再按 task_id 查询状态。"}
    elif method=="ping":
        result = {}
    elif method=="tools/list":
        result = {"tools":list(TOOLS.values())}
    elif method=="tools/call":
        name = params.get("name")
        try:
            if not isinstance(name,str) or name not in TOOLS:
                raise chat.ToolError("工具不存在")
            arguments = params.get("arguments",{})
            chat.validate(arguments,TOOLS[name]["inputSchema"])
            value = await run_tool(req,user,tid,name,arguments)
            images = []
            if isinstance(value,Preview):
                value, images = value.summary,value.images
            result = {"content":[{"type":"text","text":chat.dumps(value)},*images],"structuredContent":value}
        except (chat.ToolError,web.HTTPException,ValueError) as exc:
            message = str(exc) if isinstance(exc,chat.ToolError) else getattr(exc,"reason","参数无效")
            result = {"isError":True,"content":[{"type":"text","text":message}]}
    else:
        return rpc_error(-32601,"Method not found",identifier)
    return reply({"jsonrpc":"2.0","id":identifier,"result":result})


def install(app, root):
    app["connector_root"] = root
    app["connector_preview_slots"] = asyncio.Semaphore(2)
    app.add_routes(routes)
