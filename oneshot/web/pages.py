"""Serve the workspace, login, and console pages."""

from aiohttp import web

from oneshot import config


async def index(_):
    return web.FileResponse(config.ROOT / "static" / "index.html", headers={"Cache-Control": "no-cache"})


async def login_page(_):
    return web.FileResponse(config.ROOT / "static" / "login.html", headers={"Cache-Control": "no-cache"})


async def console_page(_):
    return web.FileResponse(config.ROOT / "static" / "console.html", headers={"Cache-Control": "no-cache"})
