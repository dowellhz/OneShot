"""Browser consent and OAuth discovery for public MCP clients."""
import base64
import hashlib
import hmac
import html
import ipaddress
import json
import os
import re
import secrets
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from aiohttp import web

from oneshot.assistant import agent_chat
from oneshot.web import auth
from oneshot.storage import db
from oneshot.integrations import mcp_bridge as bridge

routes = web.RouteTableDef()
METADATA = "/.well-known/oauth-protected-resource/mcp"
SCOPE = "oneshot:connect"
ACCESS_SECONDS = 3600
CONSENT_SECONDS = 600
CODE_SECONDS = 300
REGISTRATION_SECONDS = 3600
BASE64URL = re.compile(r"[A-Za-z0-9_-]{43}")
VERIFIER = re.compile(r"[A-Za-z0-9._~-]{43,128}")
CONTROL_OR_SPACE = re.compile(r"[\x00-\x20\x7f\\]")
AUTHORITY = re.compile(r"[A-Za-z0-9.:\[\]-]+")


def loopback(host):
    if host=="localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def checked_url(value):
    if not isinstance(value,str) or not value or not value.isascii() or len(value)>2048 or CONTROL_OR_SPACE.search(value):
        raise ValueError("invalid URL")
    parts = urlsplit(value)
    # Reading port also rejects malformed or out-of-range ports.
    port = parts.port
    if not parts.hostname or not AUTHORITY.fullmatch(parts.netloc) or port==0:
        raise ValueError("invalid host")
    return parts


def issuer(req):
    public = req.app["connector_oauth_origin"]
    if public:
        proxy_tls = loopback(req.remote) and req.headers.get("X-Forwarded-Proto")=="https"
        if req.host.casefold()==urlsplit(public).netloc and (req.secure or proxy_tls):
            return public
    if req.app["connector_oauth_dev"] and loopback(req.remote):
        try:
            host = checked_url("http://"+req.host)
        except ValueError:
            return None
        if loopback(host.hostname) and not host.path and not host.query and not host.fragment:
            return "http://"+host.netloc.lower()
    return None


def resource(req):
    origin = issuer(req)
    return origin+"/mcp" if origin else None


def challenge(req):
    origin = issuer(req)
    if not origin:
        return "Bearer"
    return f'Bearer resource_metadata="{origin}{METADATA}", scope="{SCOPE}"'


def require_issuer(req):
    origin = issuer(req)
    if not origin:
        raise web.HTTPNotFound()
    return origin


def oauth_error(error, description):
    return bridge.reply({"error":error,"error_description":description},400)


async def request_fields(req, content_type):
    if req.content_type!=content_type:
        raise ValueError("invalid content type")
    raw = bytearray()
    async for chunk in req.content.iter_chunked(4096):
        raw.extend(chunk)
        if len(raw)>16384:
            raise ValueError("request too large")
    if content_type=="application/json":
        value = json.loads(raw)
        if not isinstance(value,dict):
            raise ValueError("expected object")
        return value
    pairs = parse_qsl(raw.decode("utf-8"),keep_blank_values=True,strict_parsing=True,max_num_fields=20,errors="strict")
    fields = dict(pairs)
    if len(fields)!=len(pairs):
        raise ValueError("duplicate parameters")
    return fields


@routes.get(METADATA)
async def protected_resource(req):
    origin = require_issuer(req)
    return bridge.reply({"resource":origin+"/mcp","authorization_servers":[origin],
                         "scopes_supported":[SCOPE],"bearer_methods_supported":["header"]})


@routes.get("/.well-known/oauth-authorization-server")
async def metadata(req):
    origin = require_issuer(req)
    return bridge.reply({"issuer":origin,"authorization_endpoint":origin+"/oauth/authorize",
        "token_endpoint":origin+"/oauth/token","registration_endpoint":origin+"/oauth/register",
        "revocation_endpoint":origin+"/oauth/revoke","scopes_supported":[SCOPE],
        "grant_types_supported":["authorization_code","refresh_token"],"response_types_supported":["code"],
        "token_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"]})


def redirect_uri(value):
    parts = checked_url(value)
    if parts.fragment or (parts.scheme!="https" and not (parts.scheme=="http" and loopback(parts.hostname))):
        raise ValueError("redirect must use HTTPS or loopback")
    reserved = {"code","state","error","error_description"}
    if reserved.intersection(dict(parse_qsl(parts.query,max_num_fields=20))):
        raise ValueError("reserved callback parameter")
    return parts


@routes.post("/oauth/register")
async def register(req):
    require_issuer(req)
    try:
        data = await request_fields(req,"application/json")
        label, redirects = data.get("client_name","外部 MCP 客户端"),data.get("redirect_uris")
        if (not isinstance(label,str) or not 1<=len(label.strip())<=80 or
                not isinstance(redirects,list) or not 1<=len(redirects)<=8 or
                data.get("token_endpoint_auth_method","none")!="none" or
                data.get("response_types",["code"])!=["code"]):
            raise ValueError("invalid client metadata")
        for uri in redirects:
            redirect_uri(uri)
        redirects = sorted(set(redirects))
        grants = data.get("grant_types",["authorization_code"])
        if not isinstance(grants,list) or "authorization_code" not in grants or any(
                grant not in ("authorization_code","refresh_token") for grant in grants):
            raise ValueError("invalid grant types")
    except (ValueError,TypeError,RecursionError):
        return oauth_error("invalid_client_metadata","Use a public client with an exact HTTPS or loopback callback")
    label = label.strip()
    fingerprint = bridge.digest(agent_chat.dumps([label,redirects]))
    with db.transaction():
        now = time.time()
        db.run("DELETE FROM connector_oauth_clients WHERE expires<=?",now)
        prior = db.one("SELECT id FROM connector_oauth_clients WHERE fingerprint=?",fingerprint)
        if prior:
            client = prior["id"]
            db.run("UPDATE connector_oauth_clients SET expires=? WHERE id=? AND expires IS NOT NULL",
                   now+REGISTRATION_SECONDS,client)
        else:
            if db.one("SELECT COUNT(*) AS n FROM connector_oauth_clients")["n"]>=4096:
                return bridge.reply({"error":"temporarily_unavailable"},503)
            client = agent_chat.ident("client_")
            db.run("INSERT INTO connector_oauth_clients VALUES(?,?,?,?,?)",
                   client,label,agent_chat.dumps(redirects),fingerprint,now+REGISTRATION_SECONDS)
    return bridge.reply({"client_id":client,"client_name":label,"redirect_uris":redirects,
                         "token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],
                         "response_types":["code"]},201)


def consent_error(message):
    return web.Response(text=message,status=400,headers={**bridge.HEADERS,"Referrer-Policy":"no-referrer"})


@routes.get("/oauth/authorize")
async def consent(req):
    origin = require_issuer(req)
    fields = req.query
    redirect, client_id = fields.get("redirect_uri",""),fields.get("client_id","")
    now = time.time()
    client = db.one("SELECT * FROM connector_oauth_clients WHERE id=? AND (expires IS NULL OR expires>?)",client_id,now)
    if len(fields)!=len(set(fields)) or not client or redirect not in json.loads(client["redirects"]):
        return consent_error("客户端或回调地址无效。")
    target = origin+"/mcp"
    proof = fields.get("code_challenge","")
    state = fields.get("state","")
    if (fields.get("resource")!=target or fields.get("response_type")!="code" or
            fields.get("scope",SCOPE)!=SCOPE or fields.get("code_challenge_method")!="S256" or
            not BASE64URL.fullmatch(proof) or len(state)>1024):
        return consent_error("授权参数无效，请从客户端重新连接。")
    nonce = secrets.token_urlsafe(32)
    uid = req["user"]["id"]
    session = bridge.digest(req.cookies[auth.COOKIE])
    data = {"client_id":client_id,"redirect_uri":redirect,"state":state,"resource":target,"challenge":proof}
    with db.transaction():
        db.run("DELETE FROM connector_oauth_requests WHERE expires<=?",now)
        if db.one("SELECT COUNT(*) AS n FROM connector_oauth_requests WHERE owner=?",uid)["n"]>=24:
            return consent_error("等待授权的请求过多，请稍后重试。")
        db.run("UPDATE connector_oauth_clients SET expires=? WHERE id=? AND expires IS NOT NULL",
               now+REGISTRATION_SECONDS,client_id)
        db.run("INSERT INTO connector_oauth_requests VALUES(?,?,?,?,?)",nonce,uid,session,agent_chat.dumps(data),now+CONSENT_SECONDS)
    destination = urlsplit(redirect)
    callback = html.escape(destination.netloc)
    name = html.escape(client["label"])
    account = html.escape(req["user"].get("name") or req["user"]["username"])
    return web.Response(text=f"""<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权外部助手 · OneShot</title><link rel="stylesheet" href="/static/showcase.css?v=2">
<link rel="stylesheet" href="/static/connect-agents.css?v=1">
<main class="connector"><h1>授权外部助手</h1><section class="connector-panel">
<h2>{name}</h2><p>当前账号为 {account}。授权后，此助手可以查看你拥有的画布和资产、收录素材并适配图片尺寸。图片和视频生成仍需你在画布内确认。</p>
<p>继续后将返回 {callback}。你可以在「连接外部助手」页面撤销访问。</p>
<form method="post" action="/oauth/authorize" class="connector-copy">
<input type="hidden" name="request" value="{nonce}">
<button name="decision" value="allow">允许访问</button><button name="decision" value="deny">拒绝</button>
</form></section></main></html>""",content_type="text/html",headers={
        **bridge.HEADERS,"Referrer-Policy":"same-origin",
        "Content-Security-Policy":f"default-src 'none'; style-src 'self'; form-action 'self' {destination.scheme}://{destination.netloc}; base-uri 'none'; frame-ancestors 'none'"})


@routes.post("/oauth/authorize")
async def decide(req):
    origin = require_issuer(req)
    bridge.check_origin(req)
    if req.headers.get("Origin",origin)!=origin:
        raise web.HTTPForbidden()
    try:
        fields = await request_fields(req,"application/x-www-form-urlencoded")
    except ValueError:
        return consent_error("授权表单无效。")
    now, uid = time.time(),req["user"]["id"]
    session = bridge.digest(req.cookies[auth.COOKIE])
    nonce, choice = fields.get("request",""),fields.get("decision","")
    if choice not in ("allow","deny") or not BASE64URL.fullmatch(nonce):
        return consent_error("授权表单无效。")
    with db.transaction():
        row = db.one("""SELECT data FROM connector_oauth_requests
            WHERE id=? AND owner=? AND session_digest=? AND expires>?""",nonce,uid,session,now)
        if not row:
            return consent_error("请求已过期或处理过，请从客户端重新连接。")
        data = json.loads(row["data"])
        if data["resource"]!=origin+"/mcp":
            return consent_error("授权地址已改变，请重新连接。")
        db.run("DELETE FROM connector_oauth_requests WHERE id=?",nonce)
        if choice=="allow":
            code = secrets.token_urlsafe(32)
            db.run("DELETE FROM connector_oauth_codes WHERE expires<=?",now)
            db.run("INSERT INTO connector_oauth_codes VALUES(?,?,?,?)",
                   bridge.digest(code),uid,agent_chat.dumps(data),now+CODE_SECONDS)
    result = {"code":code} if choice=="allow" else {"error":"access_denied"}
    if data["state"]:
        result["state"] = data["state"]
    callback = urlsplit(data["redirect_uri"])
    query = callback.query+"&" if callback.query else ""
    destination = urlunsplit(callback._replace(query=query+urlencode(result)))
    return web.Response(status=303,headers={**bridge.HEADERS,"Location":destination,"Referrer-Policy":"no-referrer"})


def token_pair():
    return "osm_"+secrets.token_urlsafe(32),"osr_"+secrets.token_urlsafe(32)


def token_response(access, refresh, expires=ACCESS_SECONDS):
    return bridge.reply({"access_token":access,"refresh_token":refresh,"token_type":"Bearer",
                         "expires_in":expires,"scope":SCOPE},extra={"Pragma":"no-cache"})


def exchange_code(fields, client, target, now):
    verifier, code = fields.get("code_verifier",""),fields.get("code","")
    if not VERIFIER.fullmatch(verifier) or not BASE64URL.fullmatch(code):
        return oauth_error("invalid_grant","Invalid authorization code or verification proof")
    code_hash = bridge.digest(code)
    proof = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode()
    row = db.one("""SELECT c.owner,c.data FROM connector_oauth_codes c JOIN users u ON u.id=c.owner
                   WHERE c.digest=? AND c.expires>? AND u.disabled=0""",code_hash,now)
    data = json.loads(row["data"]) if row else {}
    if (not row or data["client_id"]!=client["id"] or data["resource"]!=target or
            data["redirect_uri"]!=fields.get("redirect_uri") or not hmac.compare_digest(data["challenge"],proof)):
        return oauth_error("invalid_grant","Authorization code, callback, resource or verification proof is invalid")
    uid = row["owner"]
    if db.one("SELECT COUNT(*) AS n FROM connector_tokens WHERE owner=? AND expires>?",uid,now)["n"]>=bridge.MAX_TOKENS:
        return oauth_error("invalid_grant","Revoke an existing OneShot connection before adding another")
    tid = agent_chat.ident("k")
    access,refresh = token_pair()
    db.run("DELETE FROM connector_oauth_codes WHERE digest=?",code_hash)
    db.run("INSERT INTO connector_tokens VALUES(?,?,?,?,?,?)",
           tid,uid,client["label"],bridge.digest(access),now,now+bridge.TOKEN_LIFETIME)
    db.run("INSERT INTO connector_oauth_grants VALUES(?,?,?,?,?)",tid,client["id"],target,
           now+ACCESS_SECONDS,bridge.digest(refresh))
    db.run("UPDATE connector_oauth_clients SET expires=NULL WHERE id=?",client["id"])
    return token_response(access,refresh)


def refresh_grant(fields, client, target, now):
    refresh = fields.get("refresh_token","")
    row = db.one("""SELECT k.id,k.expires FROM connector_oauth_grants g JOIN connector_tokens k ON k.id=g.token_id
        JOIN users u ON u.id=k.owner WHERE g.refresh_digest=? AND g.resource=? AND g.client_id=?
        AND k.expires>? AND u.disabled=0""",bridge.digest(refresh),target,client["id"],now)
    if not row:
        return oauth_error("invalid_grant","The connection has expired or the refresh token is no longer active")
    lifetime = min(ACCESS_SECONDS,int(row["expires"]-now))
    if lifetime<1:
        return oauth_error("invalid_grant","The connection has expired")
    access,new_refresh = token_pair()
    db.run("UPDATE connector_tokens SET digest=? WHERE id=?",bridge.digest(access),row["id"])
    db.run("UPDATE connector_oauth_grants SET refresh_digest=?,access_expires=? WHERE token_id=?",
           bridge.digest(new_refresh),now+lifetime,row["id"])
    return token_response(access,new_refresh,lifetime)


@routes.post("/oauth/token")
async def tokens(req):
    target = require_issuer(req)+"/mcp"
    try:
        fields = await request_fields(req,"application/x-www-form-urlencoded")
    except ValueError:
        return oauth_error("invalid_request","Expected an encoded token request")
    if fields.get("resource")!=target:
        return oauth_error("invalid_target","Request the canonical OneShot MCP resource")
    if fields.get("scope",SCOPE)!=SCOPE:
        return oauth_error("invalid_scope","Only oneshot:connect is available")
    now = time.time()
    client = db.one("SELECT id,label FROM connector_oauth_clients WHERE id=? AND (expires IS NULL OR expires>?)",
                    fields.get("client_id",""),now)
    if not client:
        return oauth_error("invalid_client","Register a public client first")
    with db.transaction():
        now = time.time()
        grant = fields.get("grant_type")
        if grant=="authorization_code":
            return exchange_code(fields,client,target,now)
        if grant=="refresh_token":
            return refresh_grant(fields,client,target,now)
        return oauth_error("unsupported_grant_type","Use authorization_code or refresh_token")


@routes.post("/oauth/revoke")
async def revoke(req):
    target = require_issuer(req)+"/mcp"
    try:
        fields = await request_fields(req,"application/x-www-form-urlencoded")
    except ValueError:
        return oauth_error("invalid_request","Expected an encoded revocation request")
    secret = bridge.digest(fields.get("token",""))
    db.run("""DELETE FROM connector_tokens WHERE id IN (
        SELECT g.token_id FROM connector_oauth_grants g JOIN connector_tokens k ON k.id=g.token_id
        WHERE g.client_id=? AND g.resource=? AND (g.refresh_digest=? OR k.digest=?))""",
           fields.get("client_id",""),target,secret,secret)
    return web.Response(status=200,headers=bridge.HEADERS)


def install(app):
    public = os.environ.get("ONESHOT_MCP_PUBLIC_ORIGIN","").strip().rstrip("/")
    if public:
        parts = checked_url(public)
        if parts.scheme!="https" or parts.path or parts.query or parts.fragment:
            raise ValueError("ONESHOT_MCP_PUBLIC_ORIGIN must be an HTTPS origin")
        public = "https://"+parts.netloc.lower()
    app["connector_oauth_origin"] = public
    app["connector_oauth_dev"] = os.environ.get("ONESHOT_MCP_DEV_OAUTH")=="1"
    app["connector_oauth_resource"] = resource
    app["connector_oauth_challenge"] = challenge
    app.add_routes(routes)
