"""Install the persistent canvas assistant and its HTTP routes."""
from __future__ import annotations

from aiohttp import web

from oneshot.assistant import agent_editing
from oneshot.assistant import agent_video
from oneshot.assistant import chat_document_routes, chat_message_routes, chat_profile_routes, chat_run_routes, chat_session_routes
from oneshot.assistant import creative_skills
from oneshot.assistant.chat_http import service as service, session_for as session_for
from oneshot.assistant.chat_models import THINKING_LEVELS as THINKING_LEVELS, chat_model_option as chat_model_option
from oneshot.assistant.chat_service import AgentService, cleanup, startup
from oneshot.assistant.chat_state import (
    InternalRequest as InternalRequest,
    MAX_QUEUED_RUNS as MAX_QUEUED_RUNS,
    MAX_RUN_SECONDS as MAX_RUN_SECONDS,
    SCHEMA as SCHEMA,
    TERMINAL as TERMINAL,
    ToolError as ToolError,
    dumps as dumps,
    ident as ident,
)
from oneshot.assistant.chat_tools import (
    NODE as NODE,
    TOOL_MAP as TOOL_MAP,
    prop as prop,
    scoped_tools as scoped_tools,
    validate as validate,
)
from oneshot.memory import creative_memory
from oneshot.providers import catalog as providers
from oneshot.storage import db


routes = [
    web.route("GET", '/api/chat/profile', chat_profile_routes.get_profile),
    web.route("PUT", '/api/chat/profile', chat_profile_routes.update_profile),
    web.route("POST", '/api/chat/sessions/{sid}/profile/{cid}', chat_profile_routes.decide_profile),
    web.route("GET", '/api/chat/sessions', chat_session_routes.list_sessions),
    web.route("GET", '/api/chat/task-history', chat_session_routes.task_history),
    web.route("POST", '/api/chat/sessions', chat_session_routes.create_session),
    web.route("POST", '/api/chat/start-canvas', chat_session_routes.start_canvas_from_brief),
    web.route("GET", '/api/chat/sessions/{sid}', chat_session_routes.get_session),
    web.route("POST", '/api/chat/sessions/{sid}/memory', chat_session_routes.save_session_memory),
    web.route("POST", '/api/chat/sessions/{sid}/documents', chat_document_routes.upload_chat_document),
    web.route("DELETE", '/api/chat/sessions/{sid}/documents/{aid}', chat_document_routes.delete_chat_document),
    web.route("POST", '/api/chat/sessions/{sid}/messages', chat_message_routes.send_message),
    web.route("POST", '/api/chat/sessions/{sid}/calls/{cid}/retry', chat_run_routes.retry_call),
    web.route("POST", '/api/chat/runs/{rid}/approvals/{aid}', chat_run_routes.decide_generation),
    web.route("POST", '/api/chat/runs/{rid}/questions/{cid}', chat_run_routes.answer_questions),
    web.route("POST", '/api/chat/runs/{rid}/stop', chat_run_routes.stop_run),
    web.route("DELETE", '/api/chat/runs/{rid}/queue', chat_run_routes.remove_queued_run),
    web.route("POST", '/api/chat/runs/{rid}/undo', chat_run_routes.undo_run),
]


def install(app, host):
    app["creative_memory"] = creative_memory.Store(host)
    app.add_routes(creative_memory.routes)
    app["agent_chat"] = AgentService(app, host)
    app.add_routes(routes)
    app.add_routes(agent_editing.routes)
    app.add_routes(creative_skills.routes)
    app.on_startup.append(startup)
    # Stop agents before the shared model and HTTP session are closed.
    app.on_cleanup.insert(0, cleanup)
