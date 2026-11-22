"""Track authorized canvas exports while packaging and sending files to the browser."""

import asyncio
import mimetypes
import time
import uuid
import zipfile
from urllib.parse import quote

from aiohttp import web


CHUNK = 1024 * 1024
TTL = 1800
TRANSFERS = {}


def describe(transfer):
    return {key:transfer[key] for key in ("id","state","name","count","bytes","total","error")}


def update(transfer, state, *, delivered=0, error=None):
    transfer.update(state=state,bytes=delivered,error=error,updated=time.monotonic())


def expire():
    now = time.monotonic()
    for key, item in list(TRANSFERS.items()):
        if item["state"] in ("packing","sending") or item["updated"]+TTL > now:
            continue
        if item["count"] > 1:
            item["path"].unlink(missing_ok=True)
        del TRANSFERS[key]


def lookup(user_id, key):
    expire()
    item = TRANSFERS.get(key)
    if not item or item["owner"] != user_id:
        raise web.HTTPNotFound()
    return item


def archive(transfer, paths):
    path = transfer["path"]
    partial = path.with_suffix(".part")
    try:
        with zipfile.ZipFile(partial,"w",compression=zipfile.ZIP_STORED,allowZip64=True) as zipped:
            for index, source in enumerate(paths,1):
                with source.open("rb") as stream, zipped.open(f"{index:02d}_{source.name}","w",force_zip64=True) as output:
                    while chunk := stream.read(CHUNK):
                        output.write(chunk)
                        transfer["bytes"] += len(chunk)
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


async def package(transfer, paths):
    try:
        await asyncio.to_thread(archive,transfer,paths)
        transfer["total"] = transfer["path"].stat().st_size
        update(transfer,"ready")
    except (OSError, zipfile.BadZipFile, ValueError):
        update(transfer,"error",error="打包失败，部分源文件可能已移动，请重新选择")


def start(owner, refs, paths, name, directory):
    expire()
    active = next((item for item in TRANSFERS.values() if item["owner"]==owner and item["state"] in ("packing","sending")),None)
    if active:
        if active["refs"] == refs:
            return active
        raise web.HTTPConflict(text="已有一项素材正在打包或下载")
    key = uuid.uuid4().hex
    count = len(paths)
    directory.mkdir(parents=True,exist_ok=True)
    for old in directory.iterdir():
        if old.suffix not in (".zip",".part"):
            continue
        if time.time()-old.stat().st_mtime > TTL*2:
            old.unlink(missing_ok=True)
    path = paths[0] if count==1 else directory/(key+".zip")
    total = sum(source.stat().st_size for source in paths)
    item = TRANSFERS[key] = {"id":key,"owner":owner,"refs":refs,"path":path,"count":count,
                              "name":path.name if count==1 else name,"total":total}
    update(item,"ready" if count==1 else "packing")
    if count>1:
        item["task"] = asyncio.create_task(package(item,paths))
    return item


async def send(req, transfer):
    if transfer["state"] not in ("ready","sent"):
        raise web.HTTPConflict()
    path = transfer["path"]
    try:
        size = path.stat().st_size
    except OSError:
        update(transfer,"error",error="下载文件已失效，请重新选择素材")
        raise web.HTTPNotFound() from None
    type_ = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    fallback = "OneShot"+path.suffix
    response = web.StreamResponse(headers={
        "Content-Type":type_, "Content-Length":str(size), "Cache-Control":"private, no-store",
        "X-Content-Type-Options":"nosniff",
        "Content-Disposition":f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{quote(transfer["name"],safe="")}',
    })
    update(transfer,"sending")
    transfer["total"] = size
    try:
        await response.prepare(req)
        with path.open("rb") as source:
            while chunk := await asyncio.to_thread(source.read,CHUNK):
                async with asyncio.timeout(45):
                    await response.write(chunk)
                transfer["bytes"] += len(chunk)
        if transfer["bytes"]!=size:
            raise OSError("source size changed")
        await response.write_eof()
        update(transfer,"sent",delivered=transfer["bytes"])
    except (OSError, asyncio.CancelledError):
        update(transfer,"ready")
        raise
    return response
