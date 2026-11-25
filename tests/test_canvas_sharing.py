"""Canvas membership, reviewer permissions, and team access."""

from unittest.mock import patch
import io
import zipfile

from PIL import Image
from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from yarl import URL

from oneshot import config
from oneshot.storage import db
from oneshot.web import auth
import server

from chat_fixture import ChatFixture


class CanvasSharing(ChatFixture):
    async def test_named_team_controls_canvas_membership_and_live_access(self):
        owner = {"X-Uid":"7"}
        member = {"X-Uid":"8"}
        outsider = {"X-Uid":"9"}
        db.run("INSERT INTO users(id,username,role,pw_hash) VALUES(9,'other','member','test')")
        base = "/api/canvas-teams"
        response = await self.client.post(base,json={"name":"视觉组"},headers=owner)
        self.assertEqual(response.status,201,await response.text())
        team = await response.json()
        tid = team["id"]
        roster = base+"/"+tid+"/members"
        url = "/api/board/test"
        team_payload = {"username":"test8","action":"add"}
        self.assertEqual((await self.client.get(roster,headers=outsider)).status,404)
        self.assertEqual((await self.client.patch(roster,headers=owner,json=team_payload)).status,200)
        self.assertEqual((await self.client.patch(roster,headers=member,json={"username":"other","action":"add"})).status,403)
        self.assertEqual([t["id"] for t in (await (await self.client.get(base,headers=member)).json())],[tid])
        self.assertEqual((await (await self.client.get(base,headers=outsider)).json()),[])

        self.assertEqual((await self.client.put(url,headers=owner,json={**self.load(),"team":tid})).status,200)
        self.assertIsNone(self.load().get("team"))
        self.assertEqual((await self.client.patch(url+"/access",headers=owner,json={"team":tid})).status,200)
        self.assertFalse(self.load()["shared"])
        self.assertEqual((await self.client.patch(url+"/access",headers=owner,json={"shared":True})).status,400)
        self.assertEqual((await self.client.patch(url+"/access",headers=member,json={"team":None})).status,403)
        view = await (await self.client.get(url,headers=member)).json()
        self.assertEqual((view["access"],view["team"]),("editor",tid))
        directory = await (await self.client.get("/api/boards",headers=member)).json()
        self.assertEqual([(b["id"],b["team"]) for b in directory],[("test",tid)])
        self.assertNotEqual((await self.client.get(url,headers=outsider)).status,200)
        self.assertEqual((await self.client.get("/api/boards",headers=outsider)).status,200)
        self.assertEqual((await self.client.put(url,headers=member,json={**view,"team":None,"shared":True})).status,200)
        self.assertEqual(self.load()["team"],tid)
        self.assertFalse(self.load()["shared"])
        pulse = {"tab":"team-member-browser","view":{"cx":0,"cy":0,"k":1}}
        self.assertEqual((await self.client.put(url+"/live",headers=member,json=pulse)).status,200)

        self.assertEqual((await self.client.patch(url+"/access",headers=owner,json={"username":"test8","role":"reviewer"})).status,200)
        view = await (await self.client.get(url,headers=member)).json()
        self.assertEqual(view["access"],"reviewer")
        self.assertEqual((await self.client.put(url,headers=member,json=view)).status,403)
        self.assertEqual((await self.client.patch(url+"/access",headers=owner,json={"username":"test8","role":None})).status,200)
        self.assertEqual((await self.client.patch(roster,headers=owner,json={**team_payload,"action":"remove"})).status,200)
        self.assertEqual((await self.client.put(url+"/live",headers=member,json=pulse)).status,404)
        self.assertEqual((await self.client.get("/media",headers=member,params={"ref":self.source["ref"]})).status,404)
        self.assertEqual((await (await self.client.get("/api/boards",headers=member)).json()),[])

        self.assertEqual((await self.client.patch(roster,headers=owner,json=team_payload)).status,200)
        self.assertEqual((await self.client.patch(url+"/access",headers=owner,json={"team":None})).status,200)
        self.assertIsNone(self.load().get("team"))
        self.assertEqual((await (await self.client.get("/api/boards",headers=member)).json()),[])

    async def test_live_canvas_permissions_presence_and_view_revision(self):
        board = "/api/board/test"
        url, guest = board+"/live", {"X-Uid":"8"}
        host = {"tab":"presenter-tab-1","view":{"cx":126,"cy":-24,"k":.7},"presenting":True,
                "cursor":{"x":231,"y":183}}
        visitor = {"tab":"visitor-session-2","view":{"cx":0,"cy":0,"k":1}}
        self.assertEqual((await self.client.put(url,json=visitor,headers=guest)).status,404)
        self.assertEqual((await self.client.put(url,json={**host,"view":{**host["view"],"k":0}})).status,400)
        self.assertEqual((await self.client.put(url,json={**host,"cursor":{"x":True,"y":0}})).status,400)
        self.assertEqual((await self.client.patch(board+"/access",json={"username":"test8","role":"reviewer"})).status,200)
        baseline = self.load()
        leader = await (await self.client.put(url,json=host)).json()
        self.assertEqual(leader["rev"],baseline["rev"])
        with patch.object(server,"board_meta",wraps=server.board_meta) as read_board:
            member = await (await self.client.put(url,json=visitor,headers=guest)).json()
            read_board.assert_not_called()
        self.assertNotEqual(leader["self"],member["self"])
        presenter = next(p for p in member["participants"] if p["id"]==leader["self"])
        self.assertEqual((presenter["view"],presenter["presenting"],presenter["name"]),(host["view"],True,"test7"))
        self.assertEqual(presenter["cursor"],host["cursor"])
        await self.client.put(url,json={**host,"cursor":None})
        refreshed = await (await self.client.put(url,json=visitor,headers=guest)).json()
        self.assertIsNone(next(p["cursor"] for p in refreshed["participants"] if p["id"]==leader["self"]))
        self.assertEqual(self.load(),baseline)
        await self.client.delete(url,params={"tab":host["tab"]},headers=guest)
        self.assertEqual(len((await (await self.client.put(url,json=host)).json())["participants"]),2)
        self.app["canvas_live"].rooms["test"][member["self"]]["seen"]-=server.canvas_live.PRESENCE_TTL
        self.assertEqual(len((await (await self.client.put(url,json=host)).json())["participants"]),1)
        await self.client.put(url,json=visitor,headers=guest)
        self.assertEqual((await self.client.patch(board+"/access",json={"username":"test8","role":None})).status,200)
        updated = await (await self.client.put(url,json=host)).json()
        self.assertEqual([p["id"] for p in updated["participants"]],[leader["self"]])
        self.assertGreater(updated["rev"],baseline["rev"])
        self.assertEqual((await self.client.delete(url,params={"tab":host["tab"]})).status,200)
        self.assertFalse(self.app["canvas_live"].rooms["test"])

    async def test_folded_group_persists_for_reviewers(self):
        board = "/api/board/test"
        data = self.load()
        groups = [{"id":"g1","name":"审片","nodes":["n1","n2"],"collapsed":True,"fold":{"x":120,"y":75}}]
        data["groups"] = groups
        self.assertEqual((await self.client.put(board,json=data)).status,200)
        self.assertEqual(self.load()["groups"],groups)
        self.assertEqual((await self.client.patch(board+"/access",json={"username":"test8","role":"reviewer"})).status,200)
        response = await self.client.get(board,headers={"X-Uid":"8"})
        self.assertEqual(response.status,200)
        self.assertEqual((await response.json())["groups"],groups)

    async def test_shared_playlist_download_keeps_removed_source_refs_in_order(self):
        film = server.film
        sources = []
        for color in ("red", "green"):
            path, ref = film._new(server.COMFY_DIR,"input","playlist-source",".mp4")
            film.encode_silent(path,(Image.new("RGB",(64,64),color) for _ in range(12)),64,64,24,lambda:False,lambda _:None)
            sources.append((path,ref))
        self.board["nodes"].append({"id":"n4","type":"video","name":"审片列表","data":{"playlist":True,"film":{
            "clips":[{"node":"n8","ref":ref,"kind":"video","in":0,"out":.5} for _,ref in sources]}},"versions":[],"cur":-1})
        server.write_board(server.board_path("test"),self.board)
        refs = [sources[1][1],sources[0][1],sources[1][1]]
        headers = {"X-Uid":"8"}
        with patch.object(config,"DATA_DIR",self.root):
            denied = await self.client.post("/api/assets/export",headers=headers,json={"refs":refs})
            self.assertEqual(denied.status,400)
            self.assertEqual((await self.client.patch("/api/board/test/access",json={"username":"test8","role":"reviewer"})).status,200)
            response = await self.client.post("/api/assets/export",headers=headers,json={"refs":refs})
            self.assertEqual(response.status,200,await response.text() if response.status!=200 else "")
            with zipfile.ZipFile(io.BytesIO(await response.read())) as archive:
                self.assertEqual([archive.read(name) for name in archive.namelist()],
                                 [sources[1][0].read_bytes(),sources[0][0].read_bytes()])

    async def test_reviewer_can_see_media_and_comment_but_cannot_edit_or_grant_access(self):
        board = "/api/board/test"
        guest = {"X-Uid":"8"}
        self.assertNotEqual((await self.client.get(board, headers=guest)).status, 200)
        self.assertEqual(await (await self.client.get("/api/boards_legacy", headers=guest)).json(), [])
        invited = await self.client.patch(board+"/access", json={"username":"test8", "role":"reviewer"})
        self.assertEqual(invited.status, 200, await invited.text())
        self.assertEqual((await invited.json())["collaborators"][0]["role"], "reviewer")
        view = await (await self.client.get(board, headers=guest)).json()
        self.assertEqual(view["access"], "reviewer")
        self.assertNotIn("collaborators", view)
        self.assertEqual((await self.client.get("/media", params={"ref":self.source["ref"]}, headers=guest)).status, 200)
        self.assertEqual((await self.client.post(board+"/comments", headers=guest, json={"body":"需要看原图", "request_key":"share-review"})).status, 201)
        self.assertEqual((await self.client.put(board, headers=guest, json={**view,"name":"改名"})).status, 403)
        self.assertEqual((await self.client.patch(board+"/access", headers=guest, json={"shared":True})).status, 403)
        assistant = await self.client.post("/api/chat/sessions", headers=guest, json={"board":"test"})
        self.assertEqual(assistant.status, 400)
        self.assertIn("审阅权限", (await assistant.json())["error"])
        self.assertEqual((await self.client.post("/api/memory", headers=guest, json={"board":"test","name":"资料","kind":"document"})).status, 403)

        self.assertEqual((await self.client.patch(board+"/access", json={"shared":True})).status, 200)
        self.assertEqual((await (await self.client.get(board, headers=guest)).json())["access"], "reviewer")
        self.assertEqual((await self.client.patch(board+"/access", json={"shared":False})).status, 200)
        self.assertEqual((await self.client.patch(board+"/access", json={"username":"test8","role":"editor"})).status, 200)
        view = await (await self.client.get(board, headers=guest)).json()
        self.assertEqual(view["access"], "editor")
        changed = await self.client.put(board, headers=guest, json={
            **view, "name":"共同编辑", "owner":8, "access":"owner", "shared":True, "collaborators":{"8":"owner"},
        })
        self.assertEqual(changed.status, 200, await changed.text())
        saved = self.load()
        self.assertEqual((saved["name"],saved["owner"],saved["shared"],saved["collaborators"]), ("共同编辑",7,False,{"8":"editor"}))
        self.assertNotIn("access", saved)

        self.assertEqual((await self.client.patch(board+"/access", json={"username":"test8","role":None})).status, 200)
        self.assertNotEqual((await self.client.get(board, headers=guest)).status, 200)
        self.assertEqual((await self.client.get(board+"/comments", headers=guest)).status, 404)
        self.assertEqual((await self.client.get("/media", params={"ref":self.source["ref"]}, headers=guest)).status, 404)

    async def test_login_preserves_the_shared_canvas_link(self):
        request = make_mocked_request("GET","/?board=test")
        async def handler(_):
            self.fail("unauthenticated request reached the board page")
        with self.assertRaises(web.HTTPFound) as redirected:
            await auth.middleware(request, handler)
        url = URL(redirected.exception.location)
        self.assertEqual(url.path, "/login")
        self.assertEqual(url.query["next"], "/?board=test")
