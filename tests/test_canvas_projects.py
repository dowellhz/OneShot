"""Project grouping preserves board content and the existing board permissions."""
from urllib.parse import quote

from oneshot import config
from oneshot.generation.media_files import ref_path
from oneshot.storage import db
from oneshot.web.media import grant_media
from chat_fixture import ChatFixture


class CanvasProjects(ChatFixture):
    async def test_directory_uses_an_image_when_a_video_is_missing(self):
        image = self.source["ref"]
        video = "output:h3studio/short.mp4"
        grant_media({"id": 7}, video)
        board = self.load()
        board["nodes"] = [
            {"id":"still","type":"image","cur":0,"versions":[{"ref":image}]},
            {"id":"clip","type":"video","cur":0,"versions":[{"ref":video}]},
        ]
        saved = await self.client.put("/api/board/test", json=board)
        self.assertEqual(saved.status, 200, await saved.text())
        entry, = await (await self.client.get("/api/boards")).json()
        self.assertEqual(entry["cover"], "/media?ref=" + quote(image, safe=""))
        self.assertEqual(entry["cover_kind"], "image")

        path = ref_path(config.COMFY_DIR, video)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
        entry, = await (await self.client.get("/api/boards")).json()
        self.assertEqual(entry["cover"], "/media?ref=" + quote(video, safe=""))
        self.assertEqual(entry["cover_kind"], "video")

    async def test_batch_groups_only_owned_personal_boards_and_keeps_creation_time(self):
        index = "/api/boards"
        bulk = index+"/batch-project"
        response = await self.client.put("/api/board/new-personal",json={"name":"新画布","nodes":[],"created":1})
        self.assertEqual(response.status,200)
        self.assertEqual((await self.client.put("/api/board/guest",
            headers={"X-Uid":"8"},json={"name":"访客画布","shared":True,"nodes":[]})).status,200)
        first = {board["id"]:board for board in await (await self.client.get(index)).json()}
        self.assertGreater(first["new-personal"]["created"],1)
        self.assertIsNone(first["test"]["created"])
        self.assertEqual((await self.client.post(bulk,json={"boards":["test","guest"],"name":"不应创建"})).status,403)
        self.assertFalse(db.one("SELECT id FROM canvas_projects"))
        created = await self.client.post(bulk,json={"boards":["test","new-personal","new-personal"],"name":"素材试验"})
        self.assertEqual(created.status,200,await created.text())
        grouped = await created.json()
        self.assertEqual(grouped["count"],2)
        project = grouped["project"]["id"]
        listed = {board["id"]:board for board in await (await self.client.get(index)).json()}
        self.assertEqual({listed[bid]["project"] for bid in ["test","new-personal"]},{project})
        original = await (await self.client.get("/api/board/new-personal")).json()
        self.assertEqual((await self.client.put("/api/board/new-personal",json={
            **original,"name":"重命名","created":42})).status,200)
        new = {board["id"]:board for board in await (await self.client.get(index)).json()}
        self.assertEqual(new["new-personal"]["created"],first["new-personal"]["created"])
        team = await (await self.client.post("/api/canvas-teams",json={"name":"协作组"})).json()
        self.assertEqual((await self.client.patch("/api/board/test/access",json={"team":team["id"]})).status,200)
        self.assertEqual((await self.client.post(bulk,json={"boards":["test","new-personal"],"project":None})).status,403)
        self.assertEqual(db.one("SELECT project_id FROM canvas_project_boards WHERE board_id='new-personal'")["project_id"],project)
        self.assertEqual((await self.client.post(bulk,json={"boards":["new-personal"],"project":None})).status,200)
        self.assertIsNone(db.one("SELECT project_id FROM canvas_project_boards WHERE board_id='new-personal'"))

    async def test_batch_layout_and_submitted_mode_survive_board_reload(self):
        board = self.load()
        board["batch_layout"] = "spread"
        board["nodes"][0]["job"] = {"ids":["image-a","image-b"],"batch":{
            "layout":"fold","data":{"count":2},"edges":[{"from":"n2","to":"n1"}],
        }}
        endpoint = "/api/board/test"
        response = await self.client.put(endpoint,json=board)
        self.assertEqual(response.status,200,await response.text())
        reopened = await (await self.client.get(endpoint)).json()
        self.assertEqual(reopened["batch_layout"],"spread")
        self.assertEqual(reopened["nodes"][0]["job"],board["nodes"][0]["job"])

    async def test_group_existing_and_new_boards_then_dissolve(self):
        response = await self.client.post("/api/canvas-projects", json={"name":" 制作项目 ", "board":"test"})
        self.assertEqual(response.status, 201, await response.text())
        project = await response.json()
        self.assertEqual(project["name"], "制作项目")
        project_url = "/api/canvas-projects/" + project["id"]
        sibling = "/api/board/assembly"
        response = await self.client.put(sibling, params={"project":project["id"]}, json={"name":"剪辑", "nodes":[]})
        self.assertEqual(response.status, 200, await response.text())
        boards = await (await self.client.get("/api/boards")).json()
        self.assertEqual({b["id"]:b["project"] for b in boards}, {"test":project["id"], "assembly":project["id"]})
        self.assertEqual(self.load(), self.board)

        response = await self.client.patch(project_url, json={"name":"短片制作"})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(await (await self.client.get("/api/canvas-projects")).json(), [{"id":project["id"], "name":"短片制作"}])
        destination = await (await self.client.post("/api/canvas-projects", json={"name":"归档"})).json()
        response = await self.client.post(sibling+"/project", json={"project":destination["id"]})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(db.one("SELECT project_id FROM canvas_project_boards WHERE board_id='assembly'")["project_id"], destination["id"])
        self.assertEqual((await self.client.delete(project_url)).status, 200)
        boards = await (await self.client.get("/api/boards")).json()
        self.assertEqual({b["id"]:b["project"] for b in boards}, {"test":None, "assembly":destination["id"]})
        self.assertEqual(self.load(), self.board)
        self.assertEqual((await self.client.delete(sibling)).status, 200)
        self.assertIsNone(db.one("SELECT project_id FROM canvas_project_boards WHERE board_id='assembly'"))

    async def test_shared_board_edits_do_not_grant_project_membership_access(self):
        self.assertEqual((await self.client.put("/api/board/test", json={**self.board, "shared":True})).status, 200)
        project = await (await self.client.post("/api/canvas-projects", json={"name":"私人项目", "board":"test"})).json()
        guest = {"X-Uid":"8"}
        self.assertEqual(await (await self.client.get("/api/canvas-projects", headers=guest)).json(), [])
        shared = await (await self.client.get("/api/boards", headers=guest)).json()
        self.assertEqual([(b["id"],b["project"]) for b in shared], [("test",None)])
        for response in (
            await self.client.put("/api/board/guest", params={"project":project["id"]}, json={"nodes":[]}, headers=guest),
            await self.client.post("/api/board/test/project", json={"project":None}, headers=guest),
            await self.client.post("/api/canvas-projects", json={"name":"客人项目", "board":"test"}, headers=guest),
            await self.client.patch("/api/canvas-projects/"+project["id"], json={"name":"不能修改"}, headers=guest),
            await self.client.delete("/api/canvas-projects/"+project["id"], headers=guest),
        ):
            self.assertEqual(response.status, 400, await response.text())
        self.assertEqual(db.one("SELECT project_id FROM canvas_project_boards WHERE board_id='test'")["project_id"], project["id"])
