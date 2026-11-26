"""Execute assistant tools with scope, input, and result coordination."""
from __future__ import annotations

import asyncio
import json
import time
import uuid

from aiohttp import web

from oneshot.assistant import agent_editing
from oneshot.assistant import agent_playlist
from oneshot.assistant import agent_video
from oneshot.assistant import creative_profile
from oneshot.assistant import creative_skills
from oneshot.assistant import storyboard_execution
from oneshot.assistant.chat_state import InternalRequest, MAX_RUN_SECONDS, ToolError
from oneshot.assistant.chat_tools import (
    PLAN_TOOLS,
    STORYBOARD_SHOT_FIELDS,
    question_items,
    scoped_tools,
)
from oneshot.canvas import workflow_review
from oneshot.editing import audio_separation
from oneshot.integrations import web_research
from oneshot.memory import creative_memory
from oneshot.memory import document_review
from oneshot.storage import db


class ToolExecution:
    async def read_response(self, response):
        try:
            r = await response
            j = json.loads(r.body)
            if r.status >= 400:
                raise ToolError(j.get("error") or "操作失败")
            return j
        except web.HTTPException as e:
            try:
                msg = json.loads(e.text).get("error")
            except (ValueError, AttributeError):
                msg = e.text
            raise ToolError(msg or "操作失败") from e

    async def response(self, fn, user, payload=None, path="", query=None):
        return await self.read_response(fn(InternalRequest(self, user, payload, path, query)))

    async def wait_questions(self, run, user, cid, args):
        questions = question_items(args)
        if any(not question["prompt"] or len(question["options"]) == 1 for question in questions):
            raise ToolError("请填写问题，并为选答题提供至少两个不同选项")
        with db.transaction():
            db.run("UPDATE chat_calls SET state='question',updated=? WHERE id=? AND state='executing'",time.time(),cid)
            self.update(run,"waiting_input")
        deadline = run["data"].get("started_at",run["created"])+MAX_RUN_SECONDS
        while time.time()<deadline:
            if self.stopped(run):
                raise ToolError("已停止等待创作确认")
            self.board(user,run["board_id"])
            row = db.one("SELECT result FROM chat_calls WHERE id=?",cid)
            if row and row["result"]:
                answer = json.loads(row["result"])
                self.update(run,"running")
                return answer
            await asyncio.sleep(.5)
        raise ToolError("等待创作确认超过30分钟，请发送新消息继续")

    async def execute(self, run, user, cid, name, args):
        h = self.host
        scope = run["data"].get("execution_scope","full")
        if scope!="full" and name not in scoped_tools(run["data"]):
            label = {"analysis":"仅分析","plan":"仅拟方案","brainstorm":"头脑风暴"}[scope]
            raise ToolError(f"本轮执行范围为「{label}」，无法调用这个工具")
        if run["data"].get("shot_range_pending") and name not in PLAN_TOOLS:
            raise ToolError("请先在批量生成计划中核对并确认运行")
        if run["data"].get("previs_storyboard_pending") and name not in PLAN_TOOLS:
            raise ToolError("请先在白模编辑器核对并创建分镜")
        if name in storyboard_execution.TOOLS and name in scoped_tools(run["data"]):
            if name == "storyboard_apply":
                return storyboard_execution.apply(self,run,user,cid,args)
            return await storyboard_execution.generate_frame(self,run,user,cid,args)
        if name in storyboard_execution.TOOLS or run["data"].get("storyboard_create_pending") and name not in PLAN_TOOLS:
            raise ToolError("请先核对新分镜脚本并确认加入画布")
        if revision := run["data"].get("review_revision"):
            if name!="storyboard_revision_plan":
                raise ToolError("本轮只为已审阅的镜头拟定修改")
            script, shot = self.reviewed_shot(self.board(user,run["board_id"]),revision["evidence"])
            if args["node_id"]!=script["id"] or args["shot"]!=shot["number"]:
                raise ToolError("请为审阅指向的当前镜头拟定修改")
            if db.one("SELECT 1 FROM chat_calls WHERE run_id=? AND state='done' AND json_type(result,'$.shot_revision')='object'",run["id"]):
                raise ToolError("本轮已准备修改卡，请先核对该方案")
        if name == "ask_creative_questions":
            return await self.wait_questions(run,user,cid,args)
        if name == "creative_directions":
            return {"creative_directions":args["directions"],"text":"比较创意方向"}
        if name == "workflow_template_search":
            rows = h.search_workflow_templates(user,args.get("scope","all"),args.get("terms",[]))
            return {"workflow_templates":rows,"text":f"找到 {len(rows)} 个工作流模板" if rows else "没有匹配的工作流模板"}
        if name in ("workflow_template_inputs","workflow_template_plan"):
            row = h.workflow_template_by_id(user["id"],args["template_id"])
            if row is None:
                raise ToolError("该模板已撤销共享或不可用")
            nodes = {node["id"]:node for node in row["data"]["nodes"]}
            if name == "workflow_template_inputs":
                selected = args.get("node_ids",nodes)
                if any(nid not in nodes for nid in selected):
                    raise ToolError("模板中没有指定的节点")
                inputs = [{"node":nid,"name":nodes[nid]["name"],"field":key,"value":value[:500]}
                          for nid in selected for key,value in h.template_node_inputs(nodes[nid]).items()]
                return {"template_inputs":inputs[:24],"template_id":row["id"],"inputs_total":len(inputs),
                        "text":f"已读取「{row['name']}」的可填写项"}
            changes, seen = [], set()
            for edit in args["changes"]:
                nid, field = edit["node"],edit["field"]
                fields = h.template_node_inputs(nodes[nid]) if nid in nodes else {}
                if field not in fields or (nid,field) in seen:
                    raise ToolError("填写项不存在或重复，请重新读取模板")
                seen.add((nid,field))
                if fields[field]!=edit["value"]:
                    changes.append({**edit,"before":fields[field],"name":nodes[nid]["name"]})
            if not changes:
                raise ToolError("填写的内容与原模板相同")
            scope = "presets" if row.get("builtin") else "private" if row["owner"]==user["id"] else "catalog"
            return {"template_fill_plan":{"board":run["board_id"],"id":row["id"],"name":row["name"],"scope":scope,
                                          "inputs":changes},"text":"已准备模板填写草稿，可在预览中核对和编辑。"}
        if name == "web_search":
            provider, sources = await web_research.search(self.app["http"],**args)
            items = [{**item,"id":f"{cid}-{i}"} for i,item in enumerate(sources,1)]
            return {"provider":provider,"sources":items,"text":f"{provider} · {len(items)} 条公开来源"}
        if name == "web_save_references":
            return await web_research.save_references(self,run,user,cid,args)
        if name == "audio_services":
            return {cap:h.audio_service_options(cap) for cap in ("tts","music","sfx","seed_audio")}
        if name == "audio_generate":
            return await self.submit_audio(run,user,cid,args)
        if name == "audio_separate":
            return await audio_separation.assistant_request(self,run,user,cid,args)
        if name == "canvas_workflow_review":
            nid, version = args.get("node_id"), args.get("version")
            if version is not None and not nid:
                raise ToolError("指定版本时请选择节点")
            board = self.board(user, run["board_id"])
            if version is None and nid in run["data"].get("selected",[]):
                if ref := run["data"].get("bindings",{}).get(nid):
                    n = next((n for n in board["nodes"] if n["id"]==nid),None)
                    version = next((i for i,v in enumerate((n or {}).get("versions",[]),1) if v.get("ref")==ref),None)
                    if version is None:
                        raise ToolError("本轮引用的版本已移除，请重新选择")
            report = workflow_review.build(board, nid, version, limit=12, prompt_limit=360)
            return {"text":f"已读取 {len(report['steps'])} 个制作步骤，可打开画布复盘查看完整记录。",
                    "workflow":report}
        if name == "creative_skill_load":
            result = creative_skills.load(user["id"], run["data"], args["skill_id"], args.get("reference"))
            self.update(run)
            return result
        if name == "creative_profile_suggest":
            self.board(user,run["board_id"])
            return creative_profile.suggest(run,cid,args["scope"],args["instruction"])
        if name in creative_memory.NAMES:
            try:
                return await creative_memory.execute(self, run, user, cid, name, args)
            except web.HTTPException as e:
                raise ToolError(json.loads(e.text).get("error", e.reason)) from None
        if name in agent_video.NAMES:
            return await agent_video.execute(self, run, user, cid, name, args)
        if name in agent_playlist.NAMES:
            return await agent_playlist.execute(self,run,user,cid,name,args)
        if name == "media_describe":
            current = next((n for n in self.board(user, run["board_id"]).get("nodes", []) if n["id"] == args["node_id"]), None)
            if current and current["type"] == "video":
                return await agent_video.describe(self, run, user, args["node_id"])
        if name in agent_editing.NAMES:
            return await agent_editing.execute(self, run, user, cid, name, args)
        if name == "canvas_context":
            b = self.board(user, run["board_id"])
            run["data"]["node_state"] = {n["id"]: self.node_state(n) for n in b.get("nodes", [])}
            self.update(run)
            return self.context(user, run["board_id"], run["data"])
        if name == "canvas_focus":
            b = self.board(user, run["board_id"])
            ids = [i for i in args["node_ids"] if any(n["id"] == i for n in b.get("nodes", []))]
            if not ids:
                raise ToolError("节点已不存在")
            self.emit(run["session_id"], run["id"], "focus", {"node_ids": ids, "open_editor": args.get("open_editor", False)})
            return {"requested": True, "node_ids": ids, "note": "已向页面发出定位请求"}
        if name == "canvas_reference_plan":
            bid = run["board_id"]
            b = self.board(user, bid)
            nodes = {n["id"]:n for n in b.get("nodes", [])}
            source = nodes.get(args["source_node_id"])
            if not source or source.get("type") not in ("image","video","audio"):
                raise ToolError("原素材不是可用的图片、视频或音频节点")
            replacement_id, memory_id = args.get("replacement_node_id"), args.get("memory_id")
            if bool(replacement_id)==bool(memory_id) or (memory_id and args.get("version")) or (replacement_id and args.get("character_view")):
                raise ToolError("请选择画布节点或资产库中的一种替换来源")
            group_id = args.get("group_id")
            group = next((g for g in b.get("groups", []) if g.get("id")==group_id), None) if group_id else None
            if group_id and not group:
                raise ToolError("指定的分组已不存在")
            targets = list(dict.fromkeys(args.get("target_ids", [])))
            if any(target not in nodes or group and target not in group["nodes"] for target in targets):
                raise ToolError("部分目标节点已移除或不在指定分组")
            plan = {"board":bid,"source":source["id"],"source_name":source["name"],
                    "group":group_id,"group_name":group.get("name") if group else None,
                    "targets":targets or None}
            if memory_id:
                plan.update(self.reference_memory(user,bid,source["type"],memory_id,args.get("character_view")))
            else:
                replacement = nodes.get(replacement_id)
                if not replacement or source is replacement or source["type"] != replacement.get("type"):
                    raise ToolError("请选择两个不同且类型相同的素材节点")
                versions = replacement.get("versions") or []
                index = args.get("version")
                pinned = run["data"].get("bindings", {}).get(replacement_id)
                if index is not None:
                    index -= 1
                elif pinned:
                    index = next((i for i,v in enumerate(versions) if v.get("ref")==pinned), -1)
                else:
                    index = replacement.get("cur", -1)
                version = versions[index] if type(index) is int and 0 <= index < len(versions) else None
                if not version or not version.get("ref") or version.get("source") == "previs":
                    raise ToolError("替换版本不可用，请在画布上选择可引用的版本")
                plan.update(replacement=replacement_id,replacement_name=replacement["name"],version=index+1,ref=version["ref"])
            return {"reference_plan":plan,
                    "text":"替换方案已准备。打开预览核对受影响的连线，确认后才会改接。"}
        if name == "canvas_group_run_plan":
            bid = run["board_id"]
            b = self.board(user,bid)
            group = next((g for g in b.get("groups",[]) if g.get("id")==args["group_id"]),None)
            if not group:
                raise ToolError("指定的分组已不存在")
            members = set(group["nodes"])
            targets = set(args.get("target_ids",[]))
            if targets - members:
                raise ToolError("部分目标节点不在指定分组")
            nodes = {n["id"]:n for n in b.get("nodes",[]) if n["id"] in members
                     and n["type"] in ("image","video","audio")
                     and not n.get("data",{}).get("previs") and not n.get("data",{}).get("film")}
            if targets - nodes.keys():
                raise ToolError("部分目标节点无法在分组内生成")
            mode = args.get("mode") or ("all" if targets else "missing")
            eligible = [nid for nid in dict.fromkeys(group["nodes"]) if nid in nodes
                        and (not targets or nid in targets) and (mode=="all" or not self.current(nodes[nid]))]
            if not eligible:
                raise ToolError("选定范围内没有需要生成的节点")
            return {"group_run_plan":{"board":bid,"group":group["id"],"name":group["name"],"targets":eligible,"mode":mode},
                    "text":"分组运行计划已准备。打开预览可核对依赖顺序、预计生成数量和跳过原因。"}
        if name == "storyboard_create_plan":
            if run["data"].get("storyboard_create_pending"):
                raise ToolError("本轮已准备新的分镜脚本")
            bid = run["board_id"]
            self.board(user,bid)
            story = args["story"].strip()
            if not story:
                raise ToolError("请提供要拆分镜头的剧情")
            refs, pins = [], []
            for nid in dict.fromkeys(args.get("image_nodes", [])):
                source, version = self.source(run,user,nid)
                self.host.require_media(user,[version["ref"]])
                data = source.get("data",{})
                refs.append({"name":source["name"],"ref":version["ref"],"desc":data.get("caption",""),
                             "kind":(data.get("asset") or {}).get("kind","")})
                pins.append({"node":nid,"ref":version["ref"],"name":source["name"]})
            aspect = args.get("aspect","16:9")
            llm = self.app["llm"]
            data = run["data"]
            try:
                candidates = self.app["creative_memory"].storyboard_assets(user,bid,story,data.get("memory_ids",[]),
                    creative_memory.requested_views(data.get("memory_views",[])),explicit=data.get("explicit_memory_ids",[]))
                result = await h.tools.storyboard(llm,h.COMFY_DIR,story,refs,args.get("shots"),None,
                    args.get("style",""),aspect,args.get("target_seconds"),
                    **({"asset_candidates":candidates} if candidates else {}))
            except web.HTTPException as error:
                raise ToolError(json.loads(error.text).get("error",error.reason)) from None
            except (ValueError, RuntimeError) as error:
                raise ToolError(str(error)) from None
            self.board(user,bid)
            run["data"]["storyboard_create_pending"] = True
            self.update(run)
            return {"plan_call_id":cid,"storyboard_create":{"board":bid,"id":"n"+uuid.uuid4().hex[:24],"story":story,
                                         "aspect":aspect,"refs":pins,**result},
                    "text":"新分镜脚本已拟好，可核对各镜时长，再确认加入画布。"}
        if name in ("storyboard_context","storyboard_next_shot_plan","storyboard_visual_review","storyboard_revision_plan","storyboard_range_run_plan"):
            bid = run["board_id"]
            board = self.board(user,bid)
            script = next((n for n in board.get("nodes",[]) if n["id"]==args["node_id"] and n["type"]=="script"),None)
            if not script:
                raise ToolError("指定的分镜脚本已不存在")
            if name == "storyboard_context":
                context = self.storyboard_context(board,script,args.get("from_shot"))
                return {"storyboard":context,"text":f"已读取「{script['name']}」的分镜，共 {context['shot_count']} 镜。"}
            if name == "storyboard_visual_review":
                return await self.storyboard_visual_review(board,script,user,bid,args,run["data"].get("direct_shot_review"))
            data = script.get("data",{})
            shots = data.get("shots") or []
            if script.get("locked") is True:
                raise ToolError("请先解锁分镜脚本")
            if name == "storyboard_range_run_plan":
                first, last = args["first"], args["last"]
                if not 1 <= first <= last <= len(shots):
                    raise ToolError("镜头范围超出当前分镜")
                stage = args.get("stage","both")
                tail_mode = args.get("tail_mode","keep")
                if stage == "video" and tail_mode != "keep":
                    raise ToolError("上一镜尾帧用于生成分镜图。请选择同时生成分镜图，或保留现有尾帧引用。")
                anchors = [{"id":shot["id"]} if shot.get("id") else {"fields":{key:shot.get(key)
                    for key in ("duration","shot_size","scene","keyframe","action")}} for shot in shots[first-1:last]]
                mode = ("all" if args.get("include_existing") else "missing") if stage=="both" else (
                    stage if args.get("include_existing") else "missing_"+stage)
                run["data"]["shot_range_pending"] = True
                self.update(run)
                return {"shot_range_plan":{"board":bid,"script":script["id"],"name":script["name"],"first":first,"last":last,
                                           "anchors":anchors,"mode":mode,"tail_mode":tail_mode},
                        "text":"已准备镜头范围，打开后核对生成方式和参考素材。"}
            if name == "storyboard_revision_plan":
                index = args["shot"]-1
                if index>=len(shots):
                    raise ToolError("指定的镜头编号不存在")
                current = shots[index]
                proposed = dict(args["changes"])
                if "asset_refs" in proposed:
                    proposed["asset_refs"] = self.storyboard_asset_selection(run,user,proposed["asset_refs"])
                changes = {key:value for key,value in proposed.items()
                           if current.get(key,[] if key=="asset_refs" else None)!=value}
                if not changes:
                    raise ToolError("指定的镜头内容没有变化")
                if any(not changes[key].strip() for key in ("shot_size","camera","scene","keyframe") if key in changes):
                    raise ToolError("景别、机位、场景和首帧需要具体描述")
                if "action" in changes and not any(line.strip() for line in changes["action"]):
                    raise ToolError("请写清修改后的动作")
                return {"shot_revision":{"board":bid,"node":script["id"],"name":script["name"],"shot":index+1,
                        "shot_id":current.get("id"),"before":{key:current.get(key) for key in changes},"changes":changes},
                        "text":"镜头修改方案已准备，确认后应用到原分镜。"}
            if not shots or len(shots)!=args["after_shot"]:
                raise ToolError("分镜镜数已变化，请重新读取最后一镜")
            shot = dict(args["shot"])
            if not all(shot[key].strip() for key in ("shot_size","camera","scene","keyframe")) or not any(line.strip() for line in shot["action"]):
                raise ToolError("请写清景别、机位、场景、动作和首帧")
            if "asset_refs" in shot:
                shot["asset_refs"] = self.storyboard_asset_selection(run,user,shot["asset_refs"])
            anchor = {"count":len(shots),"style":data.get("style") or "","characters":data.get("characters") or [],
                      "last":{key:shots[-1].get(key) for key in (*STORYBOARD_SHOT_FIELDS,"asset_refs")}}
            shot_id = "s" + uuid.uuid5(uuid.NAMESPACE_URL,cid).hex[:20]
            return {"storyboard_plan":{"board":bid,"node":script["id"],"name":script["name"],"anchor":anchor,"shot_id":shot_id,"shot":shot},
                    "text":"下一镜草案已准备，确认后会附加到现有分镜脚本。"}
        if name == "canvas_create_text":
            def create(b):
                n = {"id": "a" + uuid.uuid5(uuid.NAMESPACE_URL, cid).hex[:20], "type": "text", "name": args.get("name") or "助手文本",
                     "x": max((n.get("x", 0) + self.dimensions(n)[0] for n in b["nodes"]), default=0) + 100,
                     "y": 100, "data": {"text": args["text"]}, "versions": [], "cur": -1, "job": None}
                b["nodes"].append(n)
                return {"node_id": n["id"]}
            return self.commit(run, user, cid, create)
        if name == "canvas_replace_passage":
            review = next((item for item in run["data"].get("attached_reviews",[])
                           if item["id"] == args["review_id"] and item.get("passage")),None)
            if not review:
                raise ToolError("指定的段落批注不属于本轮引用")
            def replace(b):
                n = next((n for n in b["nodes"] if n["id"] == review["node_id"] and n.get("type") == "text"),None)
                text = n.get("data",{}).get("text") if n else None
                span = document_review.locate(text,review["passage"]) if isinstance(text,str) else None
                if not span:
                    raise ToolError("批注原文已经改动或无法唯一定位，请重新选择段落")
                start, end = span
                result = text[:start] + args["text"] + text[end:]
                if len(result) > 20000:
                    raise ToolError("替换后正文超过 20,000 字符，请缩短替换内容")
                n["data"]["text"] = result
                return {"node_id":n["id"],"review_id":review["id"],"text":"已替换批注选中的文字，正文其余部分已保留。"}
            return self.commit(run,user,cid,replace)
        if name in ("canvas_update", "canvas_arrange"):
            def change(b):
                ids = args.get("node_ids") or [args.get("node_id")]
                nodes = [next((n for n in b["nodes"] if n["id"] == nid), None) for nid in dict.fromkeys(ids)]
                if not all(nodes):
                    raise ToolError("节点已不存在，请重新读取画布")
                if name == "canvas_arrange" and any(n.get("locked") is True for n in nodes):
                    raise ToolError("选中节点含有锁定项，请仅排列未锁定节点")
                fields = [k for k in ("name", "text") if k in args] if name == "canvas_update" else ["x", "y"]
                for n in nodes:
                    expected = run["data"].get("node_state", {}).get(n["id"])
                    if expected and any(expected.get(k) != self.node_state(n).get(k) for k in fields):
                        raise ToolError("用户刚刚修改了相关节点，未覆盖；请先重新读取画布，再判断下一步")
                if name == "canvas_update":
                    n = nodes[0]
                    if "text" in args and any(r["node_id"] == n["id"] and r.get("passage")
                                              for r in run["data"].get("attached_reviews",[])):
                        raise ToolError("文档带有段落批注，请用 canvas_replace_passage 修改指定段落")
                    if "text" in args and n["type"] != "text":
                        raise ToolError("只能修改文本节点的正文")
                    if "name" in args:
                        n["name"] = args["name"]
                    if "text" in args:
                        n.setdefault("data", {})["text"] = args["text"]
                else:
                    if len(nodes) < 2:
                        raise ToolError("排列至少需要两个不同节点")
                    op, gap = args["operation"], args.get("gap", 60)
                    dims = {n["id"]: self.dimensions(n) for n in nodes}
                    x0, y0 = min(n["x"] for n in nodes), min(n["y"] for n in nodes)
                    x1 = max(n["x"] + dims[n["id"]][0] for n in nodes)
                    y1 = max(n["y"] + dims[n["id"]][1] for n in nodes)
                    if op in ("horizontal", "vertical", "distributeX", "distributeY"):
                        axis, dim = ("x", 0) if op in ("horizontal", "distributeX") else ("y", 1)
                        if op.startswith("distribute"):
                            if len(nodes) < 3:
                                raise ToolError("等距分布至少需要三个节点")
                            nodes.sort(key=lambda n: n[axis])
                            end = nodes[-1][axis] + dims[nodes[-1]["id"]][dim]
                            gap = (end - nodes[0][axis] - sum(dims[n["id"]][dim] for n in nodes)) / (len(nodes) - 1)
                        cursor = nodes[0][axis]
                        for n in nodes:
                            n[axis] = round(cursor)
                            if not op.startswith("distribute"):
                                n["y" if axis == "x" else "x"] = y0 if axis == "x" else x0
                            cursor += dims[n["id"]][dim] + gap
                    else:
                        for n in nodes:
                            w, ht = dims[n["id"]]
                            if op in ("left", "right", "centerX"):
                                n["x"] = round(x0 if op == "left" else x1 - w if op == "right" else (x0 + x1 - w) / 2)
                            else:
                                n["y"] = round(y0 if op == "top" else y1 - ht if op == "bottom" else (y0 + y1 - ht) / 2)
                return {"node_ids": [n["id"] for n in nodes]}
            return self.commit(run, user, cid, change)
        if name in ("image_generate","image_generate_set"):
            images = self.image_references(run,user,args.get("reference_ids",[]))
            if name=="image_generate_set":
                return await self.submit_image_set(run,user,cid,args,images)
            return await self.submit_generation(run,user,cid,self.image_request(args,images),
                                                args.get("name") or "助手生成",h.generate_request,
                                                target_id=self.empty_generation_target(run,user,"image"))
        if name == "image_previs_frame":
            return await self.generate_previs_frame(run,user,cid,args)
        n, v = self.source(run, user, args["node_id"])
        if name == "image_export_gif":
            if "version" in args:
                if args["version"] > len(n["versions"]):
                    raise ToolError("所选图片版本已移除，请重新选择")
                v = n["versions"][args["version"]-1]
            options = {key:args[key] for key in ("rows","cols","first","last","fps","size","ping_pong") if key in args}
            result = await self.response(h.image_gif,user,{"ref":v["ref"],**options})
            return {"gif":result,"text":f"已把「{n.get('name','图片')}」的宫格序列帧导出为循环 GIF。"}
        if name == "media_describe":
            return await self.response(h.describe, user, {"images": [{"ref": v["ref"], "name": n.get("name")}], "mode": "prompt"})
        if name == "image_edit":
            mask = args.get("mask_ref")
            if mask and run["data"].get("masks", {}).get(mask) != v["ref"]:
                raise ToolError("遮罩未由本轮工具生成；请先生成选区或请用户在编辑器画选区")
            payload = {"ref": v["ref"], "mode": "region" if mask else "whole", "prompt": args["prompt"],
                       "backend": args.get("backend", "h3"), "mask": mask, "feather": 4, "strength": 1, "seed": -1}
            return await self.submit_generation(run, user, cid, payload, args.get("name") or n.get("name", "图片") + " · 修改", h.image_edit_generate, target_id=n["id"])
        if name in ("image_transform","image_upscale","image_decompose"):
            if name in ("image_upscale","image_decompose"):
                if "version" in args:
                    if args["version"] > len(n["versions"]):
                        raise ToolError("所选图片版本已移除，请重新选择")
                    v = n["versions"][args["version"]-1]
                if name == "image_upscale":
                    scale = args.get("scale",2)
                    result = await self.response(h.image_upscale_route, user, {"ref":v["ref"],"scale":scale})
                    result.update(mode=f"智能放大 {scale}×",edit={"source":v["ref"],"mode":"upscale",
                                                                "scale":scale,"model":"FSRCNN"})
                else:
                    result = await self.response(h.image_decompose_route, user, {"ref":v["ref"]})
                    result.update(mode="自动分层",edit={"source":v["ref"],"mode":"decompose"})
                if self.stopped(run):
                    raise ToolError("用户已停止本轮任务")
                self.source(run,user,n["id"],pinned_ref=v["ref"])
            else:
                result = await self.response(h.image_transform, user, {"ref": v["ref"], **{k: val for k, val in args.items() if k != "node_id"}})
            if run["data"].get("external_tool"):
                if self.stopped(run):
                    raise ToolError("用户已停止本轮任务")
                self.validate_external_task(run)
                self.source(run,user,n["id"],pinned_ref=v["ref"])
        elif name in ("image_cutout", "image_segment"):
            path = "/api/image-edit/" + ("cutout" if name == "image_cutout" else "segment")
            points = [{"x": p["x"], "y": p["y"], "label": 1 if p.get("positive", True) else 0} for p in args.get("points", [])]
            result = await self.response(h.image_edit_tool, user, {"ref": v["ref"], "points": points}, path)
            if name == "image_segment":
                from PIL import ImageOps
                selection = h.image_editor.load(h.COMFY_DIR, result["ref"]).getchannel("A")
                if args.get("invert"):
                    selection = ImageOps.invert(selection)
                result = h.image_editor.save(h.COMFY_DIR, selection, "agentmask", "input")
                run["data"].setdefault("masks", {})[result["ref"]] = v["ref"]
                self.update(run)
                return {"mask_ref": result["ref"], "node_id": n["id"], "source_ref": v["ref"]}
        else:
            raise ToolError("不支持这个工具")
        size = result.pop("resize", None) if name == "image_transform" else None
        if size is not None:
            result.update(mode="调整像素尺寸",edit={"source":v["ref"],"mode":"local","resize":size})
        return self.add_results(run, user, cid, [{**result, "source": "edit", "prompt": "", "agent_source": v["ref"]}], n.get("name", "图片") + " · " + ("抠图" if name == "image_cutout" else "调整"), target_id=n["id"])
