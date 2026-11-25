"""Prepare pinned image references and manage multi-image generation."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote
import asyncio
import copy
import hashlib
import json
import re
import time

from aiohttp import web
import aiohttp

from oneshot.assistant.chat_state import InternalRequest, ToolError, dumps
from oneshot.canvas import workflow_review
from oneshot.memory import creative_memory
from oneshot.storage import db


class ImageGeneration:
    def image_references(self, run, user, ids, fixed=None):
        images = []
        for nid in ids:
            n,v = self.source(run,user,nid,pinned_ref=(fixed or {}).get(nid))
            position = next(i for i,item in enumerate(n["versions"],1) if item["ref"]==v["ref"])
            images.append({"ref":v["ref"],"node_id":nid,"version":position,"name":n.get("name"),
                           "w":v.get("w"),"h":v.get("h")})
        return images

    @staticmethod
    def previs_composition(n):
        data = n.get("data",{}).get("previs_composition")
        if isinstance(data,dict) and data.get("enabled") is not False and data.get("ref"):
            return next((v for v in n.get("versions",[]) if v.get("ref")==data["ref"] and v.get("source")=="previs-frame"),None)
        return None

    async def generate_previs_frame(self, run, user, cid, args):
        board = self.board(user,run["board_id"])
        nodes = {n["id"]:n for n in board["nodes"]}
        target = nodes.get(args["node_id"])
        guide = self.previs_composition(target) if target and target["type"]=="image" else None
        if not guide:
            raise ToolError("没有可用的白模构图，请确认使用的是导入的分镜图节点，且构图参考已启用")
        nid = target["id"]
        edges = [edge for edge in board.get("edges",[]) if edge["to"]==nid and edge["from"]!=nid and
                 nodes.get(edge["from"],{}).get("type")=="image"]
        ids = list(dict.fromkeys(args.get("reference_ids",[edge["from"] for edge in edges])))
        if nid in ids:
            raise ToolError("白模构图会自动加入，请只指定其他参考图")
        if len(ids)>8:
            raise ToolError("请减少其他参考图，为白模构图保留一个位置")
        fixed = {} if "reference_ids" in args else {edge["from"]:edge.get("ref") for edge in edges}
        images = self.image_references(run,user,ids,fixed)
        by_node = {img["node_id"]:i for i,img in enumerate(images,1)}
        slots = {str(edge["prompt_slot"]):by_node[edge["from"]] for edge in edges
                 if edge.get("prompt_slot") and edge["from"] in by_node}
        def resolve(match):
            if (number := slots.get(match[1])) is None:
                raise ToolError("提示词使用的图片引用已断开，请重新选择")
            return f"@图{number}"
        guide_index = next((i for i,img in enumerate(images,1) if img["ref"]==guide["ref"]),len(images)+1)
        if guide_index>len(images):
            version = next(i for i,v in enumerate(target["versions"],1) if v is guide)
            images.append({"ref":guide["ref"],"node_id":nid,"version":version,"name":"白模构图","w":guide.get("w"),"h":guide.get("h")})
        prompt = re.sub(r"@图\{(\d+)\}",resolve,args["prompt"])
        prompt += f"\n按 @图{guide_index} 的机位、透视和主体位置构图。按提示词制作角色、环境、材质与光线。"
        payload = self.image_request({"prompt":prompt},[guide])
        payload["images"] = images
        if target["data"].get("quality")=="16mp":
            payload["quality"] = "16mp"
        if provider := target["data"].get("provider"):
            payload["provider"] = provider
        return await self.submit_generation(run,user,cid,payload,target["name"],self.host.generate_request,
                                            target_id=nid,composition_ref=guide["ref"])

    @staticmethod
    def image_request(args, images):
        aspect = args.get("aspect","auto")
        ar = (images[0].get("w") or 1)/(images[0].get("h") or 1) if images else 1
        if aspect!="auto":
            width,height = map(float,aspect.split(":"))
            ar = width/height
        return {"kind":"image","model":"h3img","prompt":args["prompt"],"count":args.get("count",1),
                "ar":ar,"images":copy.deepcopy(images),"quality":"4mp","turbo":True,"seed":-1,
                **({"memory_views":args["memory_views"]} if "memory_views" in args else {})}

    def prepare_image_references(self, run, user, payload):
        try:
            return self.app["creative_memory"].prepare(user,payload,
                owner_only=bool(run["data"].get("external_tool")))
        except web.HTTPException as error:
            try:
                message = json.loads(error.text).get("error")
            except (TypeError,ValueError,AttributeError):
                message = None
            raise ToolError(message or error.reason) from None

    @staticmethod
    def image_asset_names(assets):
        names = []
        for asset in assets:
            angles = [creative_memory.CHARACTER_VIEW_LABELS[ref["view"]]
                      for ref in asset.get("references",[]) if ref.get("view")]
            names.append(asset["name"] + ("（"+"、".join(angles)+"）" if angles else ""))
        return names

    def review_image_references(self, run, user, payload):
        for image in payload.get("images",[]):
            if image.get("node_id"):
                self.source(run,user,image["node_id"],pinned_ref=image["ref"])
        prepared = self.prepare_image_references(run,user,payload)
        used = prepared.get("memory_used",[])
        inputs = workflow_review.capture_generation(prepared)["inputs"]
        cost = self.host.generation_unit_cost(prepared)
        if not (used or inputs):
            return None,cost
        route = self.host.requested_generation_route(prepared,"image")
        provider = route["provider"] if route else {}
        model = route["model"] if route else None
        signature = [inputs,used,provider.get("id"),provider.get("updated"),model]
        review = {"counts":[("图",len(inputs),9)],"inputs":inputs,"assets":self.image_asset_names(used),
                  "provider":provider.get("name"),"model":model,"key":hashlib.sha256(dumps(signature).encode()).hexdigest()}
        return review,cost

    async def submit_image_set(self, run, user, cid, args, images):
        label = (args.get("name") or "").strip() or "图片套图"
        style = args.get("style","").strip()
        data = run["data"]
        memory = data.get("memory_ids",[])
        explicit = data.get("explicit_memory_ids",memory)
        explicit_views = creative_memory.requested_views(data.get("memory_views",[]))
        plan, requests, snapshots = [], [], []
        for item in args["items"]:
            name, prompt = item["name"].strip(), item["prompt"].strip()
            if not name or not prompt:
                raise ToolError("每张图都需要名称和提示词")
            aspect = item.get("aspect",args.get("aspect","auto"))
            full_prompt = style+"\n\n本张画面："+prompt if style else prompt
            payload = self.image_request({"prompt":full_prompt,"aspect":aspect},images)
            payload.update(board=run["board_id"],label=name,
                memory_ids=list(dict.fromkeys([*explicit,*item.get("memory_ids",memory)])))
            views = {**creative_memory.requested_views(item.get("memory_views",[])),**explicit_views}
            if views:
                payload["memory_views"] = creative_memory.view_selections(views)
            used = self.prepare_image_references(run,user,payload).get("memory_used",[])
            plan.append({"name":name,"prompt":prompt,"aspect":aspect,"assets":self.image_asset_names(used)})
            requests.append(payload)
            snapshots.append(used)
        await self.begin_generation(run,cid,"image",len(plan),{"label":label,"prompt":style,
                                     "items":plan,"images":images,
                                     "memory_ids":list(dict.fromkeys(a["id"] for used in snapshots for a in used)),
                                     "asset_fingerprint":hashlib.sha256(dumps(snapshots).encode()).hexdigest()},
                                    force_confirmation=True,pricing_request={"kind":"image"})
        for payload, used in zip(requests,snapshots):
            if self.prepare_image_references(run,user,payload).get("memory_used",[]) != used:
                raise ToolError(f"「{payload['label']}」的参考资产已更新。请重新检查并确认套图。")
        batch = [{**item,"state":"unsubmitted"} for item in plan]
        pending = {"ids":[],"name":label,"prompt":style,"kind":"image","batch":batch}
        for item, payload, used in zip(batch,requests,snapshots):
            if self.stopped(run):
                if pending["ids"]:
                    await self.cancel_jobs(run,user,pending["ids"])
                raise ToolError("用户已停止本轮任务")
            try:
                self.validate_external_task(run)
                for image in images:
                    self.source(run,user,image["node_id"],pinned_ref=image["ref"])
                if pending["ids"] and self.prepare_image_references(run,user,payload).get("memory_used",[]) != used:
                    raise ToolError("参考资产已更新，请重新检查后再生成这张图")
            except ToolError as exc:
                item["error"] = str(exc)
                break
            item["record"] = workflow_review.capture_generation(payload)
            request = InternalRequest(self,user,payload)
            if run["data"].get("external_tool"):
                request["connector_own_assets"] = True
            if not await self.submit_image_set_item(cid,pending,item,request,payload):
                break
        return await self.collect_image_set(run,user,cid,pending)

    async def submit_image_set_item(self, cid, pending, item, request, payload, *, retry=False):
        item["state"] = "submitting"
        db.run("UPDATE chat_calls SET result=?,updated=? WHERE id=?",dumps(pending),time.time(),cid)
        try:
            generation = (self.host.submit_prepared_generation(request,payload,fixed_route=item["retry_snapshot"].get("route"),replay=True)
                          if retry else self.host.generate_request(request,payload))
            result = await self.read_response(generation)
            ids = result.get("ids")
            if (not isinstance(ids,list) or len(ids)!=1 or not isinstance(ids[0],str) or
                    not ids[0] or ids[0] in pending["ids"]):
                raise ToolError("生成服务未返回独立任务编号")
        except (ToolError,ValueError,TypeError,OSError,aiohttp.ClientError,asyncio.TimeoutError):
            item.update(state="uncertain",error="提交结果待核实，可在任务中心查看；其余图片尚未提交")
            return False
        item.setdefault("effective_prompt",payload["prompt"])
        item.update(state="queued",id=ids[0],memory_used=result.get("memory_used",[]))
        if isinstance(result.get("memory_context"),dict):
            item["record"] = workflow_review.capture_generation({**payload,**result["memory_context"]})
        if prepared := request.get("generation_snapshot"):
            item["retry_snapshot"] = {"generation":prepared,"route":request.get("generation_route"),
                                      "refs":sorted(self.host.media_references(prepared))}
        pending["ids"].extend(ids)
        db.run("UPDATE chat_calls SET result=?,updated=? WHERE id=?",dumps(pending),time.time(),cid)
        return True

    async def collect_image_set(self, run, user, cid, pending):
        for item in pending["batch"]:
            if item["state"]=="submitting":
                item.update(state="uncertain",error="服务中断时正在提交，可在任务中心核实")
            if item["state"]=="unsubmitted":
                item.setdefault("error","本张尚未提交")
        if pending["ids"]:
            return await self.wait_submitted_jobs(run,user,cid,pending)
        return self.finish_image_set(run,user,cid,pending,{})

    def finish_image_set(self, run, user, cid, pending, states):
        versions, completed, summary = [], [], []
        for item in pending["batch"]:
            entry = {key:item[key] for key in ("name","state","error") if key in item}
            if jid := item.get("id"):
                entry["job_id"] = jid
                state = states[jid]
                output = next((out for out in state.get("outputs") or [] if
                               Path(out["ref"]).suffix.lower() in (".png",".jpg",".jpeg",".webp")),None)
                if output:
                    meta,media = state.get("meta") or {},output.get("meta") or {}
                    receipt = copy.deepcopy(item["record"])
                    receipt["service"] = meta.get("provider") or receipt.get("service")
                    receipt["effective_prompt"] = meta.get("prompt") or receipt.get("effective_prompt")
                    if meta.get("model"):
                        receipt["settings"]["provider_model"] = meta["model"]
                    versions.append({**(output.get("extra") or {}),"ref":output["ref"],
                        "url":"/media?ref="+quote(output["ref"],safe=""),"w":media.get("width"),"h":media.get("height"),
                        "prompt":item["effective_prompt"],"seed":meta.get("seed"),"source":"gen",
                        "memory_used":item["memory_used"],"generation_record":receipt})
                    completed.append(item)
                    entry["state"] = "done"
                else:
                    entry.update(state="error",error=str(state.get("error") or "任务没有返回可用图片")[:280])
            summary.append(entry)
        result = self.add_results(run,user,cid,versions,pending["name"],variants=completed) if versions else {"nodes":[]}
        ready = iter(result["nodes"])
        for entry in summary:
            if entry["state"]=="done":
                entry["node_id"] = next(ready)["id"]
        errors = [entry["name"]+" · "+entry["error"] for entry in summary if entry.get("error")]
        self.record_image_set_retry(run,cid,pending,states)
        return {**result,"batch":summary,**({"errors":errors} if errors else {}),
                **({"error":"这组图片没有生成可用结果"} if not versions else {})}
