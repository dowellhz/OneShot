import base64
import hashlib
import re
import time
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import agent_chat
import auth
import connector_oauth
import db
import mcp_bridge
import server
from test_agent_chat import ChatFixture


class OAuthIntegration(ChatFixture):
    async def test_browser_consent_pkce_refresh_and_revocation(self):
        app = web.Application(middlewares=[auth.middleware])
        app["http"] = self.http
        agent_chat.install(app,server)
        mcp_bridge.install(app,server.ROOT)
        with patch.dict("os.environ",{"ONESHOT_MCP_DEV_OAUTH":"1","ONESHOT_MCP_PUBLIC_ORIGIN":""}):
            connector_oauth.install(app)
        for uid in (7,8):
            db.run("INSERT INTO sessions VALUES(?,?,?,?)",f"oauth-{uid}",uid,time.time(),time.time()+600)
        owner, other = ({"Cookie":f"{auth.COOKIE}=oauth-{uid}"} for uid in (7,8))
        async with TestClient(TestServer(app)) as client:
            origin = str(client.make_url("/")).rstrip("/")
            target = origin+"/mcp"
            resource = await (await client.get("/.well-known/oauth-protected-resource/mcp")).json()
            self.assertEqual((resource["resource"],resource["authorization_servers"]),(target,[origin]))
            meta = await (await client.get("/.well-known/oauth-authorization-server")).json()
            self.assertEqual(meta["code_challenge_methods_supported"],["S256"])
            unauth = await client.post("/mcp",json={})
            self.assertEqual(unauth.status,401)
            self.assertIn("resource_metadata=",unauth.headers["WWW-Authenticate"])

            redirect = "http://127.0.0.1:47100/reply?carry=yes"
            for bad in ("http://example.com/reply","https://demo.invalid;unsafe/reply","https://user@demo.invalid/reply",
                        "https://demo.invalid/#fragment","https://demo.invalid/reply?%63ode=fake"):
                invalid = await client.post("/oauth/register",json={"redirect_uris":[bad]})
                self.assertEqual(invalid.status,400)
            registered = await client.post("/oauth/register",json={"client_name":"<b>桌面助手</b>","redirect_uris":[redirect]})
            self.assertEqual(registered.status,201)
            cid = (await registered.json())["client_id"]
            verifier = "A"*64
            proof = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            params = {"response_type":"code","client_id":cid,"redirect_uri":redirect,"resource":target,
                      "scope":"oneshot:connect","state":"preserve state","code_challenge":proof,"code_challenge_method":"S256"}
            self.assertEqual((await client.get("/oauth/authorize",params=params,allow_redirects=False)).status,302)
            for bad in ({"redirect_uri":redirect+"/mismatch"},{"resource":"https://wrong.invalid/mcp"},{"code_challenge_method":"plain"}):
                invalid = await client.get("/oauth/authorize",params={**params,**bad},headers=owner,allow_redirects=False)
                self.assertEqual(invalid.status,400)
                self.assertNotIn("Location",invalid.headers)
            view = await client.get("/oauth/authorize",params=params,headers=owner)
            self.assertEqual(view.status,200)
            body = await view.text()
            self.assertIn("&lt;b&gt;桌面助手&lt;/b&gt;",body)
            nonce = re.search(r'name="request" value="([^"]+)"',body)[1]
            allow = {"request":nonce,"decision":"allow"}
            self.assertEqual((await client.post("/oauth/authorize",headers=other,data=allow,allow_redirects=False)).status,400)
            self.assertEqual((await client.post("/oauth/authorize",headers={**owner,"Origin":"https://wrong.invalid"},
                data=allow,allow_redirects=False)).status,403)
            approved = await client.post("/oauth/authorize",headers=owner,data=allow,allow_redirects=False)
            self.assertEqual(approved.status,303,await approved.text())
            callback = parse_qs(urlsplit(approved.headers["Location"]).query)
            self.assertEqual((callback["state"],callback["carry"]),(["preserve state"],["yes"]))
            code = callback["code"][0]
            self.assertEqual((await client.post("/oauth/authorize",headers=owner,data=allow,allow_redirects=False)).status,400)
            grant = {"grant_type":"authorization_code","client_id":cid,"redirect_uri":redirect,"resource":target,
                     "code":code,"code_verifier":verifier}
            for bad in ({"code_verifier":"B"*64},{"resource":"https://wrong.invalid/mcp"},{"redirect_uri":redirect+"/mismatch"}):
                self.assertEqual((await client.post("/oauth/token",data={**grant,**bad})).status,400)
            token = await (await client.post("/oauth/token",data=grant)).json()
            self.assertEqual(token["expires_in"],3600)
            self.assertEqual((await client.post("/oauth/token",data=grant)).status,400)

            rpc = {"jsonrpc":"2.0","id":1,"method":"tools/list"}
            async def use(secret, host=None):
                headers = {"Authorization":"Bearer "+secret}
                if host:
                    headers["Host"] = host
                return await client.post("/mcp",json=rpc,headers=headers)
            self.assertEqual((await use(token["access_token"])).status,200)
            self.assertEqual((await use(token["access_token"],"localhost:8101")).status,401)
            refresh = {"grant_type":"refresh_token","client_id":cid,"resource":target,"refresh_token":token["refresh_token"]}
            rolled = await (await client.post("/oauth/token",data=refresh)).json()
            self.assertNotEqual(rolled["refresh_token"],token["refresh_token"])
            self.assertEqual((await use(token["access_token"])).status,401)
            self.assertEqual((await client.post("/oauth/token",data=refresh)).status,400)
            self.assertEqual((await use(rolled["access_token"])).status,200)
            all_connections = await (await client.get("/api/connector/tokens",headers=owner)).json()
            self.assertEqual(len(all_connections),1)
            self.assertTrue(all_connections[0]["oauth"])
            self.assertEqual((await client.delete("/api/connector/tokens/"+all_connections[0]["id"],headers=owner)).status,200)
            self.assertEqual((await use(rolled["access_token"])).status,401)
            self.assertEqual((await client.post("/oauth/token",data={**refresh,"refresh_token":rolled["refresh_token"]})).status,400)

            view = await client.get("/oauth/authorize",params=params,headers=owner)
            nonce = re.search(r'name="request" value="([^"]+)"',await view.text())[1]
            denied = await client.post("/oauth/authorize",headers=owner,data={"request":nonce,"decision":"deny"},allow_redirects=False)
            self.assertEqual(denied.status,303)
            self.assertEqual(parse_qs(urlsplit(denied.headers["Location"]).query)["error"],["access_denied"])
            self.assertEqual(db.q("SELECT id FROM connector_tokens"),[])
