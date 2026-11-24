"""Assemble the OneShot HTTP application and manage its lifecycle."""

import asyncio
import sys

import aiohttp
from aiohttp import web

from engine import h3_int8
from oneshot import config
from oneshot.assistant import agent_chat
from oneshot.canvas import asset_transfers
from oneshot.canvas import board_store
from oneshot.canvas import canvas_live
from oneshot.canvas import comments as canvas_comments
from oneshot.canvas import creative_events
from oneshot.canvas import public_canvas
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas import shared_canvas_items
from oneshot.canvas import sharing as canvas_sharing
from oneshot.canvas import showcase
from oneshot.canvas import showcase_routes
from oneshot.canvas import template_routes
from oneshot.canvas import workflow_presets
from oneshot.canvas import workflow_review
from oneshot.canvas.board_store import access_role
from oneshot.canvas.board_store import BOARD_ID as _ID
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_edit
from oneshot.canvas.board_store import can_see
from oneshot.config import DATA_DIR as DATA, ROOT
from oneshot.editing import audio_routes
from oneshot.editing import audio_separation
from oneshot.editing import audio_waveform
from oneshot.editing import broll
from oneshot.editing import camera_plan
from oneshot.editing import image_camera
from oneshot.editing import image_editor
from oneshot.editing import image_routes
from oneshot.editing import image_upscale
from oneshot.editing import object_edit
from oneshot.editing import previs
from oneshot.editing import render as film
from oneshot.editing import timeline_routes
from oneshot.editing import tts
from oneshot.editing import video_remake
from oneshot.editing import video_routes
from oneshot.generation import fields as pfields
from oneshot.generation import generation_watermark
from oneshot.generation import graphs
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import local as local_generation
from oneshot.generation import motion_reference
from oneshot.generation import prompts
from oneshot.generation import reference as video_reference
from oneshot.generation import remote_jobs
from oneshot.generation import requests as generation_requests
from oneshot.generation import rewriter
from oneshot.generation import tools
from oneshot.generation import video_prompt_adapters
from oneshot.integrations import connector_oauth
from oneshot.integrations import mcp_bridge
from oneshot.memory import creative_memory
from oneshot.memory import document_review
from oneshot.memory import legacy_routes
from oneshot.providers import catalog as providers
from oneshot.providers import remote
from oneshot.providers import routes as provider_routes
from oneshot.storage import db
from oneshot.web import auth
from oneshot.web import console_routes as console
from oneshot.web import history as media_history
from oneshot.web import http as http_errors
from oneshot.web import local_admin
from oneshot.web import media as media_routes
from oneshot.web import pages as web_pages
from oneshot.web import routing
from oneshot.web import settings_routes
from oneshot.web.routing import console_routes, routes


async def on_start(app):
    db.conn()
    providers.seed()
    providers.migrate_settings(config.DATA_DIR / "settings.json")
    app["on_first_admin"] = canvas_routes.on_first_admin
    app["http"] = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120))
    app["ws_task"] = asyncio.create_task(generation_jobs.comfy_ws(app))
    app["llm"] = rewriter.LLM(config.COMFY, lambda: app["http"])
    app["llm_task"] = asyncio.create_task(app["llm"].reaper())
    app["tts_task"] = asyncio.create_task(tts.reaper())
    app["remote_tasks"] = set()
    generation_jobs.recover_remote_videos(app)


async def on_stop(app):
    app["ws_task"].cancel()
    app["llm_task"].cancel()
    app["llm"].stop()
    app["tts_task"].cancel()
    tts.stop()
    tasks = tuple(app["remote_tasks"])
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await app["http"].close()


def create_app():
    app = web.Application(client_max_size=64 * 1024 * 1024, middlewares=[auth.middleware, media_routes.media_input_guard])
    agent_chat.install(app, sys.modules[__name__])
    canvas_live.install(app, sys.modules[__name__])
    app.add_routes(routing.routes)
    app.add_routes(auth.routes)
    app.add_routes(routing.console_routes)
    app.add_routes(local_admin.routes)
    creative_events.install(app,config.ROOT,config.COMFY_DIR)
    mcp_bridge.install(app,config.ROOT)
    shared_canvas_items.install(app,sys.modules[__name__])
    connector_oauth.install(app)
    app.router.add_static("/static", config.STATIC_DIR)
    app.on_startup.insert(0, on_start)
    app.on_cleanup.append(on_stop)
    return app


def main():
    app = create_app()
    web.run_app(app, host="0.0.0.0", port=config.PORT, access_log_class=motion_reference.PublicAccessLogger,
                print=lambda *_: print(f"OneShot: http://0.0.0.0:{config.PORT}", flush=True))


_FEATURE_MODULES = (
    canvas_comments,
    canvas_routes,
    canvas_sharing,
    showcase_routes,
    template_routes,
    config,
    audio_routes,
    image_routes,
    timeline_routes,
    video_routes,
    graphs,
    generation_jobs,
    local_generation,
    prompts,
    video_reference,
    remote_jobs,
    generation_requests,
    legacy_routes,
    provider_routes,
    console,
    media_history,
    http_errors,
    media_routes,
    web_pages,
    settings_routes,

)


def __getattr__(name):
    """Resolve legacy host attributes while callers move to feature modules."""
    for module in _FEATURE_MODULES:
        if name in vars(module):
            return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


if __name__ == "__main__":
    main()
