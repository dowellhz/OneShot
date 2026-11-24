"""Registration, publication, and review of timed creative events."""
import json
import secrets
import time

from aiohttp import FormData, web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from oneshot.web import auth
from oneshot.canvas import creative_events
from oneshot.storage import db
import server
from test_agent_chat import ChatFixture


class EventIntegration(ChatFixture):
    def event_client(self):
        app = web.Application(middlewares=[auth.middleware])
        app.add_routes(server.routes)
        creative_events.install(app,server.ROOT,server.COMFY_DIR)
        db.run("UPDATE users SET role='admin' WHERE id=8")
        for uid in (7,8):
            db.run("INSERT INTO sessions VALUES(?,?,?,?)",f"event-{uid}",uid,time.time(),time.time()+600)
        return TestClient(TestServer(app))

    async def test_public_results_require_closed_review_and_exact_revision(self):
        async with self.event_client() as client:
            owner, admin = ({"Cookie":f"{auth.COOKIE}=event-{uid}"} for uid in (7,8))
            now = time.time()
            settings = {"title":"短片展","brief":"上传成片","rules":"公开评选","starts":now-10,"closes":now+90,
                        "slots":3,"registration":False,"tracks":["动画"],
                        "criteria":"镜头与叙事","prizes":"最佳短片奖"}
            event = await (await client.post("/api/admin/events",json=settings,headers=admin)).json()
            eid = event["id"]
            url, review = f"/api/events/{eid}", f"/api/admin/events/{eid}"
            results_url = review+"/results"
            tokens = [secrets.token_urlsafe(32) for _ in range(3)]
            for index,token in enumerate(tokens):
                db.run("""INSERT INTO showcase_entries
                    (token,board_id,owner,node_id,video_ref,cover,title,description,state,submitted)
                    VALUES(?,?,7,?,?,?,?,'','approved',?)""",
                       token,"test",f"n{index}","ref",b"jpg",f"作品 {index}",now)
                self.assertEqual((await client.post(url+"/entries",headers=owner,
                    json={"token":token,"track":"动画"})).status,201)
            outcome = {"revision":0,"summary":"评选结束","confirmed":True,"awards":[
                {"token":tokens[1],"label":"最佳短片"},{"token":tokens[0],"label":"最佳叙事"}]}
            self.assertEqual((await client.get(results_url,headers=owner)).status,403)
            self.assertEqual((await client.put(results_url,headers=owner,json=outcome)).status,403)
            self.assertEqual((await client.put(results_url,headers=admin,json=outcome)).status,409)
            initial = await (await client.get(url)).json()
            self.assertEqual(initial["judging"],{"criteria":"镜头与叙事","prizes":"最佳短片奖"})
            self.assertIsNone(initial["results"])
            db.run("UPDATE creative_events SET closes=? WHERE id=?",now-1,eid)
            self.assertEqual((await (await client.get(url)).json())["state"],"closed")
            self.assertEqual((await client.put(results_url,headers=admin,json=outcome)).status,409)
            for token,state in zip(tokens,("approved","approved","rejected")):
                self.assertEqual((await client.patch(review+"/entries/"+token,headers=admin,
                    json={"state":state,"reason":"内部评审备注"})).status,200)
            editor = await (await client.get(results_url,headers=admin)).json()
            self.assertEqual({row["token"] for row in editor["candidates"]},set(tokens[:2]))
            self.assertEqual((await client.put(results_url,headers=admin,json={**outcome,"confirmed":False})).status,400)
            self.assertEqual((await client.put(results_url,headers=admin,json={**outcome,
                "awards":[outcome["awards"][0],outcome["awards"][0]]})).status,400)
            self.assertEqual((await client.put(results_url,headers=admin,json={**outcome,
                "awards":[{"token":tokens[2],"label":"不可选"}]})).status,409)
            published = await client.put(results_url,headers=admin,json=outcome)
            self.assertEqual(published.status,200,await published.text())
            public = await (await client.get(url)).json()
            self.assertEqual(public["state"],"ended")
            self.assertEqual([(a["token"],a["label"]) for a in public["results"]["awards"]],
                             [(tokens[1],"最佳短片"),(tokens[0],"最佳叙事")])
            self.assertNotIn("内部评审备注",json.dumps(public,ensure_ascii=False))
            self.assertEqual((await (await client.get("/api/events")).json())[0]["state"],"ended")
            self.assertEqual((await client.put(results_url,headers=admin,json=outcome)).status,409)
            updated = await client.put(results_url,headers=admin,json={**outcome,"revision":1,"summary":"更正公告"})
            self.assertEqual(updated.status,200,await updated.text())
            update = await updated.json()
            self.assertEqual((update["revision"],update["published"]),(2,public["results"]["published"]))
            db.run("DELETE FROM showcase_entries WHERE token=?",tokens[1])
            self.assertIsNone(db.one("SELECT token FROM event_awards WHERE event_id=? AND token=?",eid,tokens[1]))
            after = await (await client.get(url)).json()
            self.assertEqual([a["token"] for a in after["results"]["awards"]],[tokens[0]])
            self.assertEqual(after["results"]["summary"],"更正公告")

    async def test_publish_and_submit_rolls_back_on_limit_and_keeps_both_review_stages(self):
        async with self.event_client() as client:
            owner, admin = ({"Cookie":f"{auth.COOKIE}=event-{uid}"} for uid in (7,8))
            now = time.time()
            settings = {"title":"短片","brief":"上传成片","rules":"公开展映","starts":now-1,"closes":now+90,
                        "slots":1,"registration":False,"tracks":["动画"],"max_seconds":1.0}
            event = await (await client.post("/api/admin/events",json=settings,headers=admin)).json()
            eid = event["id"]
            url = "/api/events/"+eid
            review = "/api/admin/events/"+eid
            publish = "/api/board/test/showcase"
            path,ref = server.film._new(server.COMFY_DIR,"input","event-canvas",".mp4")
            server.film.encode_silent(path,(Image.new("RGB",(64,64),"red") for _ in range(12)),
                                      64,64,24,lambda:False,lambda _:None)
            board = self.load()
            board["nodes"].append({"id":"n3","name":"成片","type":"video","versions":[{"ref":ref}],"cur":0})
            server.board_path("test").write_text(json.dumps(board))
            metadata = {"title":"画布短片","event":eid,"track":"动画","revision":board["rev"],"confirmed":True}
            canvas = {**metadata,"video":{"node":"n3","ref":ref}}
            self.assertEqual((await client.post(publish,headers=owner,json={**canvas,"track":"实拍"})).status,400)
            self.assertFalse(db.q("SELECT * FROM showcase_entries"))
            result = await client.post(publish,headers=owner,json=canvas)
            self.assertEqual(result.status,201,await result.text())
            receipt = await result.json()
            token = receipt["token"]
            self.assertEqual((receipt["state"],receipt["event_entry"]["state"]),("pending","pending"))
            self.assertEqual((await (await client.get(review,headers=admin)).json())["entries"],[])
            decision = {"state":"approved"}
            self.assertEqual((await client.patch(review+"/entries/"+token,headers=admin,json=decision)).status,409)
            other = await (await client.post("/api/admin/events",json=settings,headers=admin)).json()
            other_id = other["id"]
            self.assertEqual((await client.post(publish,headers=owner,json={**canvas,"event":other_id})).status,201)

            def upload():
                form = FormData()
                form.add_field("metadata",json.dumps({**metadata,"title":"本地短片"}))
                form.add_field("video",path.read_bytes(),filename="local.mp4",content_type="video/mp4")
                return form

            clipped = await client.post(publish,headers=owner,data=upload())
            self.assertEqual(clipped.status,409,await clipped.text())
            self.assertEqual([r["token"] for r in db.q("SELECT token FROM showcase_entries")],[token])
            self.assertFalse(list((server.COMFY_DIR/"showcase").glob("*.mp4")))
            gallery = "/api/admin/showcase/"
            self.assertEqual((await client.patch(gallery+token,headers=admin,json={
                "state":"rejected","reason":"请替换作品"})).status,200)
            personal = await (await client.get(url+"/me",headers=owner)).json()
            self.assertEqual(personal["entries"][0]["publication_reason"],"请替换作品")
            self.assertEqual(personal["entries"][0]["state"],"rejected")
            self.assertEqual((await client.post(publish,headers=owner,json={
                k:v for k,v in canvas.items() if k not in ("event","track")})).status,201)
            self.assertEqual((await client.patch(gallery+token,headers=admin,json=decision)).status,200)
            other_queue = await (await client.get("/api/admin/events/"+other_id,headers=admin)).json()
            self.assertEqual(other_queue["entries"],[])
            uploaded = await client.post(publish,headers=owner,data=upload())
            self.assertEqual(uploaded.status,201,await uploaded.text())
            uploaded_token = (await uploaded.json())["token"]
            self.assertNotEqual(token,uploaded_token)
            self.assertEqual((await client.patch(gallery+uploaded_token,headers=admin,json=decision)).status,200)
            self.assertEqual((await client.get(url)).status,200)
            self.assertEqual((await (await client.get(url)).json())["entries"],[])
            self.assertEqual((await client.patch(review+"/entries/"+uploaded_token,headers=admin,json=decision)).status,200)
            self.assertEqual((await (await client.get(url)).json())["entries"][0]["token"],uploaded_token)
            self.assertEqual((await client.post(publish,headers=owner,json=canvas)).status,409)
            self.assertEqual(db.one("SELECT state FROM event_entries WHERE event_id=? AND token=?",eid,token)["state"],"rejected")
            gif_path, gif_ref = server.film._new(server.COMFY_DIR,"output","gif",".gif")
            Image.new("RGB",(32,32),"red").save(gif_path)
            server.grant_media({"id":7},gif_ref)
            gif = {**metadata,"gif_ref":gif_ref}
            unsupported = await client.post(publish,headers=owner,json=gif)
            self.assertEqual(unsupported.status,400,await unsupported.text())
            standalone = await client.post(publish,headers=owner,json={
                k:v for k,v in gif.items() if k not in ("event","track")})
            self.assertEqual(standalone.status,201,await standalone.text())
            gif_token = (await standalone.json())["token"]
            self.assertEqual((await client.patch(gallery+gif_token,headers=admin,json=decision)).status,200)
            personal = await (await client.get(url+"/me",headers=owner)).json()
            self.assertNotIn(gif_token,{row["token"] for row in personal["works"]})
            self.assertEqual((await client.post(url+"/entries",headers=owner,json={
                "token":gif_token,"track":"动画"})).status,400)

    async def test_approved_registration_submission_limits_and_public_results(self):
        app = web.Application(middlewares=[auth.middleware])
        creative_events.install(app,server.ROOT,server.COMFY_DIR)
        db.run("UPDATE users SET role='admin' WHERE id=8")
        db.run("INSERT INTO users(id,username,role,pw_hash) VALUES(9,'visitor','member','test')")
        for uid in (7,8,9):
            db.run("INSERT INTO sessions VALUES(?,?,?,?)",f"event-{uid}",uid,time.time(),time.time()+600)
        owner, admin, outsider = ({"Cookie":f"{auth.COOKIE}=event-{uid}"} for uid in (7,8,9))
        path, ref = server.film._new(server.COMFY_DIR,"input","event-source",".mp4")
        server.film.encode_silent(path,(Image.new("RGB",(64,64),"red") for _ in range(12)),
                                  64,64,24,lambda:False,lambda _:None)
        tokens = [secrets.token_urlsafe(32) for _ in range(3)]
        for i,token in enumerate(tokens):
            db.run("""INSERT INTO showcase_entries
                (token,board_id,owner,node_id,video_ref,cover,title,description,state,submitted,published)
                VALUES(?,?,?,?,?,?,?,'','approved',?,?)""",
                   token,"test",9 if i==2 else 7,"n"+str(i),ref,b"jpg","公开作品 "+str(i),time.time(),time.time())
        now = time.time()
        settings = {"title":"限时创作","brief":"围绕纸船创作","rules":"可任选一种赛道","starts":now-1,"closes":now+90,
                    "slots":1,"registration":True,"tracks":["动画","实拍"],"min_seconds":.2,"max_seconds":1.0}
        async with TestClient(TestServer(app)) as client:
            admin_api = "/api/admin/events"
            self.assertEqual((await client.post(admin_api,json=settings,headers=owner)).status,403)
            self.assertEqual((await client.post(admin_api,json={**settings,"closes":now-2},headers=admin)).status,400)
            event = await (await client.post(admin_api,json=settings,headers=admin)).json()
            eid = event["id"]
            url, review = "/api/events/"+eid, admin_api+"/"+eid
            self.assertEqual((await client.get("/events/"+eid)).status,200)
            self.assertEqual((await client.get(url+"/me")).status,401)
            payload = {"token":tokens[0],"track":"动画"}
            self.assertEqual((await client.post(url+"/entries",headers=owner,json=payload)).status,403)
            self.assertEqual((await client.post(url+"/registration",headers=owner,json={"note":"我的报名草稿"})).status,200)
            self.assertNotIn("我的报名草稿",await (await client.get(url)).text())
            pending = await (await client.get(review,headers=admin)).json()
            self.assertEqual(pending["registrations"][0]["note"],"我的报名草稿")
            self.assertEqual((await client.patch(review+"/registration/7",headers=admin,json={"state":"rejected"})).status,400)
            self.assertEqual((await client.patch(review+"/registration/7",headers=admin,json={"state":"rejected","reason":"请补说明"})).status,200)
            self.assertEqual((await (await client.get(url+"/me",headers=owner)).json())["registration"]["reason"],"请补说明")
            await client.post(url+"/registration",headers=owner,json={"note":"补充完成"})
            await client.patch(review+"/registration/7",headers=admin,json={"state":"approved"})
            self.assertEqual((await client.post(url+"/entries",headers=owner,json={**payload,"token":tokens[2]})).status,404)
            self.assertEqual((await client.post(url+"/entries",headers=outsider,json={"token":tokens[2],"track":"实拍"})).status,403)
            self.assertEqual((await client.post(url+"/entries",headers=owner,json={**payload,"track":"未知"})).status,400)
            self.assertEqual((await client.post(url+"/entries",headers=owner,json=payload)).status,201)
            self.assertEqual((await client.post(url+"/entries",headers=owner,json=payload)).status,200)
            self.assertEqual((await client.post(url+"/entries",headers=owner,json={**payload,"token":tokens[1]})).status,409)
            self.assertEqual((await (await client.get(url)).json())["entries"],[])
            self.assertEqual((await client.patch(review+"/entries/"+tokens[0],headers=admin,json={"state":"approved"})).status,200)
            public = await (await client.get(url)).json()
            self.assertEqual([(e["token"],e["track"]) for e in public["entries"]],[(tokens[0],"动画")])
            db.run("DELETE FROM showcase_entries WHERE token=?",tokens[0])
            self.assertEqual((await (await client.get(url)).json())["entries"],[])
            self.assertEqual((await client.post(url+"/entries",headers=owner,json={**payload,"token":tokens[1]})).status,201)
            db.run("UPDATE creative_events SET closes=? WHERE id=?",now-1,eid)
            self.assertEqual((await client.post(url+"/entries",headers=owner,json=payload)).status,409)

            direct = await (await client.post(admin_api,headers=admin,json={**settings,"registration":False,
                "min_seconds":2,"max_seconds":None})).json()
            direct_url = "/api/events/"+direct["id"]
            self.assertEqual((await client.post(direct_url+"/entries",headers=owner,json={**payload,"token":tokens[1]})).status,400)
