"""Register HTTP routes in their original matching order."""

from aiohttp import web

from oneshot.canvas import comments as canvas_comments
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas import sharing as canvas_sharing
from oneshot.canvas import showcase_routes
from oneshot.canvas import template_routes
from oneshot.editing import audio_edit_routes
from oneshot.editing import audio_routes
from oneshot.editing import audio_stem_routes
from oneshot.editing import image_routes
from oneshot.editing import timeline_routes
from oneshot.editing import transcription_routes
from oneshot.editing import video_routes
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import motion_reference
from oneshot.generation import prompts
from oneshot.generation import queue as generation_queue
from oneshot.generation import reference as video_reference
from oneshot.generation import remote_jobs
from oneshot.generation import requests as generation_requests
from oneshot.memory import legacy_routes
from oneshot.providers import routes as provider_routes
from oneshot.web import console_routes as console
from oneshot.web import history as media_history
from oneshot.web import media as media_routes
from oneshot.web import pages as web_pages
from oneshot.web import settings_routes


routes = [
    web.route("GET", "/", web_pages.index),
    web.route("GET", "/login", web_pages.login_page),
    web.route("GET", "/console", web_pages.console_page),
    web.route("GET", "/api/canvas-projects", canvas_routes.list_canvas_projects),
    web.route("POST", "/api/boards/batch-project", canvas_routes.move_boards_to_project),
    web.route("POST", "/api/canvas-projects", canvas_routes.create_canvas_project),
    web.route("PATCH", "/api/canvas-projects/{pid}", canvas_routes.rename_canvas_project),
    web.route("DELETE", "/api/canvas-projects/{pid}", canvas_routes.dissolve_canvas_project),
    web.route("POST", "/api/board/{bid}/project", canvas_routes.move_canvas_project),
    web.route("GET", "/api/boards", canvas_routes.list_boards),
    web.route("GET", "/api/boards_legacy", canvas_routes.list_boards_legacy),
    web.route("GET", "/api/board/{bid}", canvas_routes.get_board),
    web.route("PUT", "/api/board/{bid}", canvas_routes.put_board),
    web.route("GET", "/api/board/{bid}/workflow-review", canvas_routes.get_workflow_review),
    web.route("DELETE", "/api/board/{bid}", canvas_routes.delete_board),
    web.route("GET", "/api/canvas-teams", canvas_routes.canvas_teams),
    web.route("POST", "/api/canvas-teams", canvas_routes.create_canvas_team),
    web.route("GET", "/api/canvas-teams/{tid}/members", canvas_routes.canvas_team_members),
    web.route("PATCH", "/api/canvas-teams/{tid}/members", canvas_routes.update_canvas_team_members),
    web.route("GET", "/api/board/{bid}/access", canvas_routes.get_board_access),
    web.route("PATCH", "/api/board/{bid}/access", canvas_routes.update_board_access),
    web.route("GET", "/api/board/{bid}/snapshot", canvas_sharing.board_snapshot_status),
    web.route("PUT", "/api/board/{bid}/snapshot", canvas_sharing.publish_board_snapshot),
    web.route("DELETE", "/api/board/{bid}/snapshot", canvas_sharing.revoke_board_snapshot),
    web.route("GET", r"/share/{token:[A-Za-z0-9_-]{43}}", canvas_sharing.public_snapshot_page),
    web.route("GET", r"/api/share/{token:[A-Za-z0-9_-]{43}}", canvas_sharing.public_snapshot_data),
    web.route("GET", r"/api/share/{token:[A-Za-z0-9_-]{43}}/media/{index:\d{1,6}}", canvas_sharing.public_snapshot_media),
    web.route("POST", r"/api/share/{token:[A-Za-z0-9_-]{43}}/explain", canvas_sharing.copy_public_snapshot),
    web.route("POST", r"/api/share/{token:[A-Za-z0-9_-]{43}}/copy", canvas_sharing.copy_public_snapshot),
    web.route("GET", r"/showcase/creator/{slug:[a-f0-9]{32}}", showcase_routes.showcase_page),
    web.route("GET", r"/showcase/{token:[A-Za-z0-9_-]{43}}", showcase_routes.showcase_page),
    web.route("GET", "/showcase", showcase_routes.showcase_page),
    web.route("GET", "/api/showcase", showcase_routes.showcase_feed),
    web.route("GET", r"/api/showcase/creator/{slug:[a-f0-9]{32}}", showcase_routes.showcase_creator),
    web.route("GET", "/api/showcase/me", showcase_routes.showcase_my_entries),
    web.route("GET", r"/api/showcase/{token:[A-Za-z0-9_-]{43}}", showcase_routes.showcase_detail),
    web.route("POST", r"/api/showcase/{token:[A-Za-z0-9_-]{43}}/use-prompt", showcase_routes.use_showcase_prompt),
    web.route("GET", r"/api/showcase/{token:[A-Za-z0-9_-]{43}}/{asset:cover|video|gif}", showcase_routes.showcase_public_media),
    web.route("GET", "/api/board/{bid}/showcase", showcase_routes.board_showcase),
    web.route("POST", "/api/board/{bid}/showcase", showcase_routes.submit_showcase),
    web.route("DELETE", r"/api/board/{bid}/showcase/{token:[A-Za-z0-9_-]{43}}", showcase_routes.withdraw_showcase),
    web.route("PUT", r"/api/board/{bid}/showcase/{token:[A-Za-z0-9_-]{43}}/template", showcase_routes.update_showcase_template),
    web.route("DELETE", r"/api/board/{bid}/showcase/{token:[A-Za-z0-9_-]{43}}/prompt", showcase_routes.revoke_showcase_prompt),
    web.route("GET", "/api/admin/showcase", showcase_routes.showcase_pending),
    web.route("GET", r"/api/admin/showcase/{token:[A-Za-z0-9_-]{43}}/{asset:cover|video|gif}", showcase_routes.showcase_pending_media),
    web.route("GET", r"/showcase-review/{token:[A-Za-z0-9_-]{43}}", showcase_routes.showcase_review_page),
    web.route("GET", r"/api/admin/showcase/{token:[A-Za-z0-9_-]{43}}/canvas", showcase_routes.showcase_review_snapshot),
    web.route("GET", r"/api/admin/showcase/{token:[A-Za-z0-9_-]{43}}/canvas/media/{index:\d{1,6}}", showcase_routes.showcase_review_snapshot_media),
    web.route("PATCH", r"/api/admin/showcase/{token:[A-Za-z0-9_-]{43}}", showcase_routes.review_showcase),
    web.route("GET", r"/api/canvas-templates/{scope:catalog|presets|favorites}", template_routes.list_templates),
    web.route("GET", "/api/canvas-templates", template_routes.list_templates),
    web.route("PUT", "/api/canvas-templates/{tid}/favorite", template_routes.favorite_template),
    web.route("DELETE", "/api/canvas-templates/{tid}/favorite", template_routes.unfavorite_template),
    web.route("POST", "/api/canvas-templates", template_routes.save_template),
    web.route("PATCH", "/api/canvas-templates/{tid}", template_routes.rename_template),
    web.route("PUT", "/api/canvas-templates/{tid}/content", template_routes.replace_template_content),
    web.route("GET", "/api/canvas-templates/{tid}/history", template_routes.list_template_history),
    web.route("GET", r"/api/canvas-templates/{tid}/history/{version:\d{1,16}}", template_routes.read_template_history),
    web.route("POST", r"/api/canvas-templates/{tid}/history/{version:\d{1,16}}/restore", template_routes.restore_template_history),
    web.route("DELETE", "/api/canvas-templates/{tid}", template_routes.delete_template),
    web.route("PUT", "/api/canvas-templates/{tid}/publication", template_routes.publish_template),
    web.route("DELETE", "/api/canvas-templates/{tid}/publication", template_routes.unpublish_template),
    web.route("GET", "/api/canvas-templates/{tid}/preview", template_routes.preview_template),
    web.route("GET", r"/api/canvas-templates/{tid}/preview/media/{index:\d{1,6}}", template_routes.preview_template_media),
    web.route("POST", "/api/canvas-templates/{tid}/fragment", template_routes.template_fragment),
    web.route("POST", "/api/canvas-templates/{tid}/open", template_routes.open_template),
    web.route("GET", "/api/board/{bid}/comments", canvas_comments.list_comments),
    web.route("POST", "/api/board/{bid}/comments", canvas_comments.post_comment),
    web.route("PATCH", "/api/board/{bid}/comments/{cid}", canvas_comments.resolve_comment),
    web.route("GET", "/api/assets", media_routes.assets),
    web.route("POST", "/api/upload", media_routes.upload),
    web.route("GET", "/media", media_routes.media),
    web.route("GET", motion_reference.LEASE_PREFIX + '{token}', motion_reference.serve),
    web.route("GET", "/api/generation-history", media_history.generation_history),
    web.route("GET", "/api/media-favorites", media_history.list_media_favorites),
    web.route("POST", "/api/media-favorites", media_history.update_media_favorite),
    web.route("POST", "/api/preview", generation_requests.preview),
    web.route("POST", "/api/generate", generation_requests.generate),
    web.route("POST", "/api/image-edit/transform", image_routes.image_transform),
    web.route("POST", "/api/image-edit/selection-cutout", image_routes.image_layers),
    web.route("POST", "/api/image-edit/layers", image_routes.image_layers),
    web.route("POST", "/api/image-edit/openraster", image_routes.image_openraster),
    web.route("GET", "/api/image-edit/drafts/{board}/{node}", image_routes.image_draft_get),
    web.route("POST", "/api/image-edit/drafts/{board}/{node}", image_routes.image_draft_save),
    web.route("PUT", "/api/image-edit/drafts/{board}/{node}", image_routes.image_draft_save),
    web.route("GET", "/api/image-edit/capabilities", image_routes.image_edit_capabilities),
    web.route("POST", "/api/image-edit/upscale", image_routes.image_upscale_route),
    web.route("POST", "/api/image-edit/cutout", image_routes.image_edit_tool),
    web.route("POST", "/api/image-edit/segment", image_routes.image_edit_tool),
    web.route("POST", "/api/image-edit/decompose", image_routes.image_decompose_route),
    web.route("POST", "/api/image-edit/fill-background", image_routes.image_fill_background_route),
    web.route("POST", "/api/assets/export", media_routes.export_assets),
    web.route("POST", "/api/assets/transfers", media_routes.start_asset_transfer),
    web.route("GET", "/api/assets/transfers/{key}", media_routes.asset_transfer_status),
    web.route("GET", "/api/assets/transfers/{key}/file", media_routes.download_asset_transfer, allow_head=False),
    web.route("POST", "/api/image-edit/generate", image_routes.image_edit_generate),
    web.route("POST", "/api/generation-cost", generation_requests.generation_cost),
    web.route("GET", "/api/jobs", generation_jobs.jobs),
    web.route("POST", "/api/cancel", generation_jobs.cancel),
    web.route("POST", "/api/lastframe", video_routes.lastframe),
    web.route("GET", "/api/video/frame-preview", video_routes.video_frame_preview),
    web.route("POST", "/api/rewrite", prompts.rewrite),
    web.route("POST", "/api/storyboard", prompts.storyboard),
    web.route("POST", "/api/describe", prompts.describe),
    web.route("POST", "/api/analyze", prompts.analyze),
    web.route("POST", "/api/video/trim", video_routes.trim_video),
    web.route("POST", "/api/video/gif", video_routes.video_gif),
    web.route("POST", "/api/image/gif", video_routes.image_gif),
    web.route("POST", "/api/video-remake/{board}/{node}", video_routes.remake),
    web.route("GET", "/api/video-remake/{board}/{node}", video_routes.remake),
    web.route("POST", "/api/split", video_routes.split),
    web.route("POST", "/api/concat", video_routes.concat),
    web.route("GET", "/api/library", legacy_routes.library),
    web.route("POST", "/api/library", legacy_routes.library_put),
    web.route("DELETE", "/api/library/{aid}", legacy_routes.library_del),
    web.route("POST", "/api/render/check", timeline_routes.render_check),
    web.route("POST", "/api/render", timeline_routes.render_film),
    web.route("POST", "/api/broll/draft", timeline_routes.draft_broll),
    web.route("POST", "/api/broll/render", timeline_routes.render_broll),
    web.route("POST", "/api/previs/camera-motion", timeline_routes.previs_camera_motion),
    web.route("POST", "/api/previs/object-motion", timeline_routes.previs_object_motion),
    web.route("POST", "/api/previs/render", timeline_routes.render_previs),
    web.route("POST", "/api/cover", timeline_routes.cover),
    web.route("GET", "/api/transcription", transcription_routes.transcription_status),
    web.route("POST", "/api/transcription", transcription_routes.transcribe_audio),
    web.route("GET", "/api/audio/waveform", audio_edit_routes.get_audio_waveform),
    web.route("GET", "/api/audio/separate", audio_stem_routes.latest_stems),
    web.route("POST", "/api/audio/separate", audio_stem_routes.request_stems),
    web.route("POST", "/api/audio/cut", audio_edit_routes.audio_cut),
    web.route("POST", "/api/audio/transcript", transcription_routes.audio_transcript),
    web.route("POST", "/api/video/captions", transcription_routes.video_captions),
    web.route("POST", "/api/upload_audio", audio_routes.upload_audio),
    web.route("GET", "/api/voices", audio_routes.voices),
    web.route("POST", "/api/tts", audio_routes.tts_say),
    web.route("POST", "/api/audio/generate", audio_routes.generate_audio),
    web.route("GET", "/api/queue", generation_queue.queue),
    web.route("GET", "/api/settings", settings_routes.get_settings),
    web.route("PUT", "/api/settings", settings_routes.put_settings),
    web.route("POST", "/api/settings/test", settings_routes.test_settings),
    web.route("GET", "/api/samples", canvas_routes.samples),
    web.route("POST", "/api/samples/{sid}/open", canvas_routes.sample_open),
    web.route("POST", "/api/video/reference-models", video_reference.video_reference_models),
    web.route("POST", "/api/video/draft/finalize", remote_jobs.finalize_video_draft),
    web.route("GET", "/api/status", console.status),
]


console_routes = [
    web.route("GET", "/api/capabilities", provider_routes.capabilities),
    web.route("GET", "/api/admin/providers", console.admin_providers),
    web.route("POST", "/api/admin/providers", console.admin_provider_save),
    web.route("DELETE", "/api/admin/providers/{pid}", console.admin_provider_del),
    web.route("POST", "/api/admin/providers/{pid}/test", console.admin_provider_test),
    web.route("GET", "/api/llm", console.llm_get),
    web.route("PUT", "/api/admin/llm", console.llm_put),
    web.route("PUT", "/api/admin/routes/{cap}", console.admin_route),
    web.route("GET", "/api/tasks", console.task_list),
]
