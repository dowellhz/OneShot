"""Transient viewport and pointer presence for accounts with access to the same canvas."""
import re
import time
from uuid import uuid4

from aiohttp import web

from oneshot.storage import db

PRESENCE_TTL = 8
TAB = re.compile(r"[A-Za-z0-9-]{12,80}")
routes = web.RouteTableDef()


class Presence:
    def __init__(self, host):
        self.host = host
        self.rooms = {}
        self.metadata = {}
        self.comment_versions = {}

    def comments_changed(self, bid):
        if bid in self.rooms:
            self.comment_versions[bid] = uuid4().hex

    def board(self, req):
        bid = req.match_info["bid"]
        path = self.host.board_path(bid)
        try:
            stat = path.stat()
        except OSError:
            stat = None
        stamp = (stat.st_ino,stat.st_mtime_ns,stat.st_size) if stat else None
        cached = self.metadata.get(bid)
        if stamp is None:
            self.metadata.pop(bid,None)
            board = None
        elif cached and cached[0]==stamp:
            board = cached[1]
        else:
            stored = self.host.board_meta(path)
            board = {"owner":stored.get("owner"),"shared":stored.get("shared"),
                     "team":stored.get("team"),
                     "collaborators":stored.get("collaborators"),"rev":stored.get("rev",0)} if stored else None
        if not board or not self.host.can_see(req["user"],board):
            raise web.HTTPNotFound(text='{"error":"画布不存在或无法访问"}',content_type="application/json")
        return bid,board,stamp

    def prune(self, now):
        for bid,room in list(self.rooms.items()):
            for key,member in list(room.items()):
                if now-member["seen"]>=PRESENCE_TTL:
                    del room[key]
            if not room:
                del self.rooms[bid]
                self.metadata.pop(bid,None)
                self.comment_versions.pop(bid,None)

    def participants(self, room, board):
        uids = {p["uid"] for p in room.values()}
        accounts = {row["id"]:row for row in db.q(
            "SELECT id,name,username,role FROM users WHERE disabled=0 AND id IN ("+
            ",".join("?" for _ in uids)+")",*uids)}
        peers = []
        for key,p in list(room.items()):
            account = accounts.get(p["uid"])
            if not account or not self.host.can_see(account,board):
                del room[key]
                continue
            peers.append({"id":key,"name":account["name"] or account["username"],
                          "view":p["view"],"presenting":p["presenting"],"cursor":p["cursor"]})
        return peers


def valid_view(view):
    return isinstance(view,dict) and set(view)=={"cx","cy","k"} and all(
        type(view[key]) in (float,int) and lo<=view[key]<=hi
        for key,lo,hi in (("cx",-1e9,1e9),("cy",-1e9,1e9),("k",.05,10))
    )


def valid_cursor(cursor):
    return cursor is None or (
        isinstance(cursor,dict) and set(cursor)=={"x","y"}
        and all(type(point) in (int,float) and -1e9<=point<=1e9 for point in cursor.values())
    )


@routes.put("/api/board/{bid}/live")
async def heartbeat(req):
    service = req.app["canvas_live"]
    data = await req.json()
    if not isinstance(data,dict) or not isinstance(data.get("tab"),str) or not TAB.fullmatch(data["tab"]) or (
        not valid_view(data.get("view")) or not valid_cursor(data.get("cursor"))
        or type(data.get("presenting",False)) is not bool
    ):
        return web.json_response({"error":"协作视角格式无效"},status=400)
    uid, now = req["user"]["id"], time.monotonic()
    service.prune(now)
    bid,board,stamp = service.board(req)
    service.metadata[bid] = (stamp,board)
    key = f"{uid}:{data['tab']}"
    if bid not in service.rooms:
        service.rooms[bid] = {}
        service.comments_changed(bid)
    room = service.rooms[bid]
    room[key] = {"uid":uid,"seen":now,"view":data["view"],"presenting":data.get("presenting",False),
                 "cursor":data.get("cursor")}
    people = service.participants(room,board)
    return web.json_response({"self":key,"participants":people,"rev":board.get("rev",0),
                              "comments_version":service.comment_versions[bid]},
                             headers={"Cache-Control":"no-store"})


@routes.delete("/api/board/{bid}/live")
async def leave(req):
    service = req.app["canvas_live"]
    bid, _, _ = service.board(req)
    tab = req.query.get("tab","")
    if TAB.fullmatch(tab):
        service.rooms.get(bid,{}).pop(f"{req['user']['id']}:{tab}",None)
    return web.json_response({"ok":True})


def install(app, host):
    app["canvas_live"] = Presence(host)
    app.add_routes(routes)
