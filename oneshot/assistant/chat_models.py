"""Select assistant models and stream progress previews."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time

import aiohttp

from oneshot.assistant.chat_state import ToolError, dumps
from oneshot.assistant.chat_tools import TOOLS, scoped_tools
from oneshot.generation import rewriter
from oneshot.providers import catalog as providers
from oneshot.storage import db


THINKING_LEVELS = ("off", "low", "high", "max")


def chat_model_option(route):
    provider, model = route["provider"], route["model"]
    key = hashlib.sha256(dumps([provider["id"], model]).encode()).hexdigest()[:24]
    levels = THINKING_LEVELS if provider["kind"] == "deepseek" and model in ("deepseek-flash", "deepseek-v4-pro") else ()
    return {"id":key,"name":provider["name"],"model":model,"levels":levels}


def chat_model_routes():
    return {chat_model_option(route)["id"]:route for route in providers.routes("text") if route["model"]}


def chat_model_session(sid):
    row = db.one("""SELECT json_extract(data,'$.chat_model') AS model FROM chat_runs
                    WHERE session_id=? AND json_type(data,'$.direct_shot_review') IS NULL ORDER BY rowid LIMIT 1""",sid)
    if row is None:
        return None
    return json.loads(row["model"]) if row["model"] else {"id":""}


def choose_chat_model(sid, payload):
    locked = chat_model_session(sid)
    choice = payload.get("chat_model",locked["id"] if locked else "")
    if locked is not None and choice != locked["id"]:
        raise ToolError("对话已锁定模型，请新建对话后再切换")
    level = payload.get("thinking_level","off")
    if not choice and level == "off":
        return {}
    route = chat_model_routes().get(choice)
    if route is None:
        raise ToolError("所选模型已不可用，请新建对话并选择可用模型")
    option = chat_model_option(route)
    if level != "off" and level not in option["levels"]:
        raise ToolError("所选模型不支持这档思考强度")
    return {"chat_model":locked or option,"thinking_level":level}


def visible_reply(text, *, partial=False):
    text = re.sub(r"<think>(?:.*?</think>|.*\Z)", "", text, flags=re.S|re.I)
    if partial:
        ending = text[-6:].lower()
        for end in range(len("<think>")-1,0,-1):
            if ending.endswith("<think>"[:end]):
                text = text[:-end]
                break
    return text.strip()


class ModelCalls:
    async def model(self, messages, run):
        routes_ = providers.routes("text")
        selected = run["data"].get("chat_model")
        if selected:
            routes_ = [route for route in routes_ if route["model"] and chat_model_option(route)["id"]==selected["id"]]
            if not routes_:
                raise ToolError("所选模型已不可用，请新建对话并选择可用模型")
        if not routes_:
            raise ToolError("请先在控制台配置可调用工具的文本模型")
        errors = []
        level = run["data"].get("thinking_level","off")
        rid = run["id"]

        def progress(raw):
            if text := visible_reply(raw,partial=True):
                self.reply_previews[rid] = {"run_id":rid,"text":text}

        async def complete(url, name, body, headers=None):
            request = {"headers":headers,"timeout":aiohttp.ClientTimeout(total=180)}
            try:
                return await providers.json_req(self.app["http"],"POST",url,name,
                                                json={**body,"stream":True},chat_progress=progress,**request)
            except providers.ChatStreamUnsupported:
                return await providers.json_req(self.app["http"],"POST",url,name,
                                                json={**body,"stream":False},**request)
            finally:
                self.reply_previews.pop(rid,None)

        for route in routes_:
            p, model = route["provider"], route["model"]
            try:
                body = {"model":model,"messages":messages}
                if "snapshot_explanation" not in run["data"]:
                    allowed = scoped_tools(run["data"])
                    if allowed:
                        body.update(tools=[tool for tool in TOOLS if tool["function"]["name"] in allowed],tool_choice="auto")
                if p["kind"] == "local_qwen":
                    llm = self.app["llm"]
                    async with llm.lock:
                        await llm.start()
                        body.update(max_tokens=1800, chat_template_kwargs={"enable_thinking": False})
                        j = await complete(f"http://127.0.0.1:{rewriter.PORT}/v1/chat/completions",p["name"],body)
                        llm.last = time.time()
                else:
                    url, headers = providers.llm_endpoint(p)
                    if p["kind"] == "openai":
                        body.update(max_completion_tokens=4000, reasoning_effort="low")
                    else:
                        body.update(max_tokens=2000, temperature=.2)
                        if p["kind"] == "dashscope":
                            body["enable_thinking"] = False
                        if p["kind"] == "deepseek":
                            body["thinking"] = {"type": "disabled"}
                            if level != "off":
                                body["thinking"] = {"type": "enabled"}
                                body["reasoning_effort"] = level
                                body["max_tokens"] = {"low":6000,"high":12000,"max":24000}[level]
                                body.pop("temperature")
                                body["messages"] = [
                                    {**m,"reasoning_content":m.get("reasoning_content","")} if m["role"]=="assistant" else m
                                    for m in messages
                                ]
                            else:
                                body["messages"] = [{k:v for k,v in m.items() if k!="reasoning_content"} for m in messages]
                    j = await complete(url,p["name"],body,headers)
                msg = j["choices"][0]["message"]
                if not isinstance(msg, dict) or (not msg.get("content") and not msg.get("tool_calls")):
                    raise ToolError("模型未返回文字或工具调用")
                run["data"]["model"] = {"provider": p["name"], "model": model}
                self.update(run)
                return {"role":"assistant","content":visible_reply(msg.get("content") or ""),
                        **({"reasoning_content":msg["reasoning_content"]} if level!="off" and isinstance(msg.get("reasoning_content"),str) else {}),
                        **({"tool_calls": msg["tool_calls"]} if msg.get("tool_calls") else {})}
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # Names only; provider errors may contain request URLs or private credentials.
                errors.append(f"{p.get('name', '模型')}：{type(e).__name__}")
        raise ToolError("模型调用失败，请检查服务和工具调用能力。" + "；".join(errors))
