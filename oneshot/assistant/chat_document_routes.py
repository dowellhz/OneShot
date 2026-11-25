"""Attach temporary documents to an assistant conversation."""
from __future__ import annotations

import time

from aiohttp import web

from oneshot.assistant.chat_http import session_for
from oneshot.assistant.chat_state import DOCUMENT_DRAFT_TTL, dumps, ident
from oneshot.memory import document_import
from oneshot.storage import db


def document_summary(doc):
    return {k:doc[k] for k in ("name","truncated")} | {"length":len(doc["text"])}


async def upload_chat_document(req):
    session = session_for(req,req.match_info["sid"])
    try:
        document = await document_import.read_upload(req)
    except document_import.UploadTooLarge as error:
        return web.json_response({"error":str(error)},status=413)
    except (ValueError,AssertionError) as error:
        return web.json_response({"error":str(error) or "无法读取上传的文档"},status=400)
    session_for(req,session["id"])
    aid, now = ident("d"), time.time()
    with db.transaction():
        db.run("DELETE FROM chat_documents WHERE created<?",now-DOCUMENT_DRAFT_TTL)
        if db.one("SELECT COUNT(*) n FROM chat_documents WHERE session_id=?",session["id"])["n"] >= 8:
            return web.json_response({"error":"此对话已有 8 个未发送附件，请移除后再上传"},status=409)
        db.run("INSERT INTO chat_documents VALUES(?,?,?,?)",aid,session["id"],dumps(document),now)
    return web.json_response({"id":aid,**document_summary(document)},status=201)


async def delete_chat_document(req):
    session = session_for(req,req.match_info["sid"])
    db.run("DELETE FROM chat_documents WHERE id=? AND session_id=?",req.match_info["aid"],session["id"])
    return web.json_response({"ok":True})
