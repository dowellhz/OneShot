"""Compose the creative memory store and register the public HTTP routes."""
from __future__ import annotations

from aiohttp import web

from oneshot.memory import memory_folder_routes
from oneshot.memory import memory_impact_routes
from oneshot.memory import memory_library_routes
from oneshot.memory import memory_transfer_routes
from oneshot.memory.memory_agent_tools import (
    NAMES as NAMES,
    execute as execute,
    register as register,
)
from oneshot.memory.memory_asset_writes import AssetWrites
from oneshot.memory.memory_generation import GenerationContext
from oneshot.memory.memory_generation_history import GenerationHistory
from oneshot.memory.memory_impact_routes import asset_impact as asset_impact
from oneshot.memory.memory_records import AssetRecords, remove_deleted_bindings as remove_deleted_bindings
from oneshot.memory.memory_retrieval import MemoryRetrieval
from oneshot.memory.memory_transfer_routes import import_canvas_assets as import_canvas_assets
from oneshot.memory.memory_values import (
    AUDIO_EXT as AUDIO_EXT,
    CHARACTER_VIEW_LABELS as CHARACTER_VIEW_LABELS,
    IMAGE_EXT as IMAGE_EXT,
    IMAGE_STORY_KINDS as IMAGE_STORY_KINDS,
    IMAGE_STORY_PROMPT_MARKER as IMAGE_STORY_PROMPT_MARKER,
    MEMORY_PROMPT_MARKER as MEMORY_PROMPT_MARKER,
    character_notes as character_notes,
    fail as fail,
    generation_asset_key as generation_asset_key,
    requested_views as requested_views,
    view_selection_schema as view_selection_schema,
    view_selections as view_selections,
    view_tokens as view_tokens,
)


class Store(AssetRecords, AssetWrites, MemoryRetrieval, GenerationContext, GenerationHistory):
    """Persist and prepare creative assets across browsing and generation."""


routes = [
    web.route("GET", "/api/memory", memory_library_routes.listing),
    web.route("GET", "/api/memory/mentions", memory_library_routes.mention_options),
    web.route("POST", "/api/document-import", memory_library_routes.upload_document),
    web.route("GET", "/api/asset-folders/references", memory_folder_routes.folder_references),
    web.route("GET", "/api/asset-folders", memory_folder_routes.list_folders),
    web.route("POST", "/api/asset-folders", memory_folder_routes.create_folder),
    web.route("PATCH", "/api/asset-folders/{fid}", memory_folder_routes.rename_folder),
    web.route("DELETE", "/api/asset-folders/{fid}", memory_folder_routes.delete_folder),
    web.route("POST", "/api/asset-folders/members", memory_folder_routes.file_assets),
    web.route("GET", "/api/memory/{mid}", memory_library_routes.detail),
    web.route("POST", "/api/memory", memory_library_routes.saving),
    web.route("POST", "/api/memory/search", memory_library_routes.search_assets),
    web.route("POST", "/api/memory/resolve", memory_library_routes.resolve_assets),
    web.route("POST", "/api/memory/review-generation", memory_library_routes.review_generation_assets),
    web.route("POST", "/api/memory/{mid}/duplicate", memory_transfer_routes.duplicate_asset),
    web.route("GET", "/api/memory/{mid}/download", memory_transfer_routes.download_asset),
    web.route("POST", "/api/memory/import-canvas", memory_transfer_routes.import_canvas_assets),
    web.route("GET", "/api/memory/{mid}/impact", memory_impact_routes.asset_impact),
    web.route("DELETE", "/api/memory/{mid}", memory_library_routes.deleting),
]
