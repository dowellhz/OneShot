"""Check that an image can serve as a single-character reference."""

import asyncio

from aiohttp import ClientError, web

from oneshot import config
from oneshot.generation import tools
from oneshot.web import http as http_errors, media

_SYSTEM = (
    "Check a character reference image. Count every depicted instance of a live or animated person, animal, "
    "or character, even a small child, pet, or partially visible figure held in the main character's arms. "
    "Repeated views in a character sheet are separate instances. A standalone character reference requires "
    "exactly one visible character. Return only JSON. Set count to -1 if it is unclear."
)
_SCHEMA = {
    "type":"object","properties":{"count":{"type":"integer","minimum":-1}},
    "required":["count"],"additionalProperties":False,
}


async def review(req):
    body = await req.json()
    ref = body.get("ref") if isinstance(body,dict) else None
    if not isinstance(ref,str) or len(ref)>300:
        raise http_errors.bad("角色参考图片无效")
    media.require_media(req["user"],[ref])
    try:
        path = tools.ref_path(config.COMFY_DIR,ref)
        if path.suffix.lower() not in (".png",".jpg",".jpeg",".webp"):
            raise ValueError()
        image = await asyncio.to_thread(tools.image_part,path,640)
    except (OSError,ValueError) as error:
        raise http_errors.bad("无法读取角色参考图片") from error
    llm = req.app["llm"]
    if not llm.local_vision_available():
        return web.json_response({"checked":False})
    try:
        raw = await llm.local_vision(_SYSTEM,[{"type":"text","text":"Count visible characters."},image],
                                     max_tokens=80,temperature=0,response_schema=_SCHEMA)
        result = tools.parse_json(raw)
    except (ClientError,OSError,RuntimeError,ValueError) as error:
        raise http_errors.bad("角色参考图检查暂时不可用") from error
    count = result.get("count") if isinstance(result,dict) else None
    if count is not None and (type(count) is not int or count<0):
        count = None
    return web.json_response({"checked":True,"count":count,"passed":count==1})
