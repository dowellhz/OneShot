"""Expose creative memory search, retrieval, and persistence to the assistant."""
from __future__ import annotations

import uuid

from oneshot.memory import document_import
from oneshot.memory.memory_values import KINDS, fail


def register(tool, prop, node):
    ids = prop("array", items=prop("string", maxLength=80), minItems=1, maxItems=8)
    tool("memory_search", "按名称或自然语言镜头描述检索人物、场景、道具、风格和背景资料。默认搜索当前画布或项目。需要个人库、共享或团队资产时可选 available。检索只返回候选，确认是否适合镜头后再采用。", {
        "query":prop("string",minLength=1,maxLength=1000),
        "kind":prop("string",enum=sorted(KINDS)),
        "scope":prop("string",enum=["current","available"]),
        "mode":prop("string",enum=["auto","semantic","keyword"]),
    }, ["query"])
    tool("memory_get", "读取记忆的设定、默认参考图、素材版本和生成历史。", {"memory_id": node}, ["memory_id"])
    tool("memory_use", "为本轮后续图片/视频生成采用记忆。append（默认）追加素材；换镜头或换场景时可用 replace 替换先前由助手选的素材，memory_ids=[] 可清除这些素材。用户通过 @ 指定的素材会保留。", {
        "memory_ids":{**ids,"minItems":0}, "mode":prop("string",enum=["append","replace"]),
    }, ["memory_ids"])
    tool("memory_save", "保存设定或当前素材。项目内默认保存到项目资产库，独立画布默认保存到该画布的资产库。修改已有资产时保留范围和默认图。", {
        "name": prop("string", minLength=1, maxLength=80), "kind": prop("string", enum=sorted(KINDS)), "description": prop("string", maxLength=6000),
        "node_id": node, "memory_id": node, "scope": prop("string", enum=["canvas", "project", "personal"]),
        "constraints": prop("string", maxLength=3000)}, ["name", "kind", "description"])


NAMES = {"memory_search", "memory_get", "memory_use", "memory_save"}


async def execute(s, run, user, cid, name, args):
    st = s.app["creative_memory"]
    bid = run["board_id"]
    if name == "memory_search":
        query = args["query"]
        items, method = await st.search(s.app["llm"],user,bid,query,kind=args.get("kind"),
                                        scope=args.get("scope","current"),mode=args.get("mode","auto"))
        return {"memories":[st.summary(a,query) for a in items],"search_method":method}
    if name == "memory_get":
        a = st.get(user, args["memory_id"], bid)
        if a.get("document"):
            a = {**a, "document":{**a["document"],"text":document_import.passage(a["document"],run["data"].get("memory_query",""),6000)}}
        return {**a, "history": st.history(user, a["id"], bid)}
    if name == "memory_use":
        items = [st.get(user, mid, bid) for mid in args["memory_ids"]]
        data = run["data"]
        previous = data.get("memory_ids",[])
        explicit = data.get("explicit_memory_ids",previous)
        replace = args.get("mode") == "replace"
        if not replace and not items:
            fail("请选择要追加的创作资产")
        adopted = list(dict.fromkeys((explicit if replace else previous) + [a["id"] for a in items]))
        if len(adopted) > 8:
            fail("一次最多采用8条记忆")
        data["memory_ids"] = adopted
        s.update(run)
        if not replace:
            return {"adopted":[st.summary(a) for a in items],"note":"已为本轮后续生成采用参考图和背景资料"}
        return {"adopted":[st.summary(a) for a in items],"retained_explicit_ids":explicit,
                "note":"已替换后续生成使用的自动参考" if items else "已清除后续生成的自动参考"}
    p = {"name": args["name"], "kind": args["kind"], "desc": args["description"]}
    if args.get("memory_id"):
        old = st.get(user, args["memory_id"], bid)
        p.update(id=old["id"])
    else:
        scope = args.get("scope")
        if scope is None:
            p.update(st.default_scope(user,bid))
        elif scope == "canvas":
            p["board"] = bid
        elif scope == "project":
            if not (project := st.project(user,bid)):
                fail("当前画布未加入你管理的项目")
            p["project"] = project
    if "constraints" in args:
        p["constraints"] = args["constraints"]
    if args.get("node_id"):
        b = s.board(user, bid)
        n = next((n for n in b["nodes"] if n["id"] == args["node_id"]), None)
        v = s.current(n) if n else None
        if not v or n["type"] not in ("image", "video"):
            fail("请引用已完成的图片或视频")
        p.update(ref=v["ref"], source_board=bid, node_id=n["id"])
    a = st.put(user, p, stable_id="m" + uuid.uuid5(uuid.NAMESPACE_URL, cid).hex[:16])
    return {"memory": st.summary(a), "note": "记忆已保存，默认参考保持不变"}
