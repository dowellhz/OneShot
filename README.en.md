# OneShot

[简体中文](README.md)

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

OneShot is a self-hosted AI video production workspace. Start with a one-line idea to generate a script, character designs, and storyboards, or bring existing images, clips, and text into the canvas to generate, revise, and edit shots into a film.

Run MiniMax-H3 and H3-Image locally, or use the web console to connect third-party model services, manage accounts, and inspect jobs.

Choose Chinese or English on the sign-in page, in the upper-right corner of the canvas, or in the console. Your browser saves your language preference.

![OneShot canvas with reference images, storyboard and video nodes, and the structured video prompt panel](docs/screenshot.png)

## Run OneShot locally

From the repository root, set up the web service with Python 3.12.

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-web.txt
.venv/bin/python server.py
```

Open `http://localhost:8190` and create the first administrator. Configure remote models in **Console**. For local image and video generation, follow GPU setup. [Linux deployment for H3 BF16, H3-Image, and INT8 ConvRot](docs/deployment.en.md)

## Getting started

1. Open **Idea to Film** to create a storyboard, or drop your media onto the canvas.
2. Open **Asset library** from the top bar to save character references, locations, or background material. Upload files or collect items already on the canvas.
3. Type `@` in the Creative Assistant or an image or video prompt. Search for an asset by name, alias, or tag. For example, select `@林森` and ask for the character to walk into a bookstore. Generation uses the character notes and default reference. The assistant can also retrieve relevant assets. Generated results enter the asset's history. You choose the default reference. To add several references together, open a personal or team folder in the `@` menu and select the items you need.
4. Arrange the shots in the timeline, add captions and sound, then export the film.

## What you can make

- Turn an idea into a script, character references, a storyboard, and an edited film.
- Link pinned image, video, and audio versions on the canvas. Use first, middle, and last frames to guide a shot.
- Save worldbuilding, character designs, and conversations in the asset library and reference them with `@`.
- Use the Creative Assistant to plan and edit on the canvas. Arrange shots, titles, captions, and sound in the timeline.

[Feature guide and external assistant setup](docs/features.en.md)

## Architecture

```text
Browser ──▶ server.py (aiohttp, :8190) ── accounts, projects, jobs, routing, PyAV rendering
              │
              ├─▶ engine/service.py (local :8189) ── MiniMax-H3 and H3-Image via Diffusers
              ├─▶ llama-server (:8191, on demand) ── Qwen3.5-9B for scripts, rewriting, vision
              ├─▶ oneshot/editing/tts_worker.py (CPU) ── Kokoro voiceover
              └─▶ Third-party APIs (oneshot/providers/remote.py)
```

| File | Responsibility |
| --- | --- |
| `server.py` / `oneshot/app.py` | Entry point, web application setup, and background service lifecycle |
| `oneshot/web/routing.py` | HTTP route registration. Feature modules own the handlers. |
| `oneshot/generation/requests.py` / `oneshot/generation/jobs.py` | Generation previews and submissions, job status, and recovery |
| `oneshot/generation/queue.py` | Generation queue status and completion estimates |
| `oneshot/generation/reference.py` / `oneshot/generation/reference_prompts.py` / `oneshot/generation/reference_media.py` | Video reference routing and previews, prompt bindings, and pinned media validation |
| `oneshot/config.py` | Repository root, data, models, and static asset paths |
| `oneshot/canvas/board_store.py` | Canvas ID and data validation, JSON reads, and atomic writes |
| `oneshot/web/auth.py` / `oneshot/storage/db.py` | Accounts with scrypt password hashing, sessions, and SQLite. API keys are encrypted with Fernet. |
| `oneshot/providers/catalog.py` / `oneshot/providers/remote.py` | Model catalog, capability routing, and third-party image, video, voiceover, and music adapters |
| `engine/h3engine.py` / `engine/h3_checkpoint.py` | Full 31B BF16 H3 inference, GPU weight streaming, checkpoint reads, and turbo LoRA merging |
| `engine/service.py` | Single-GPU queue, progress, cancellation, and on-demand switching between image and video models |
| `oneshot/generation/rewriter.py` / `oneshot/generation/fields.py` / `oneshot/generation/tools.py` | Prompt rewriting and structured assembly, storyboards, prompt extraction, shot analysis, grids, and stitching |
| `oneshot/editing/image_editor.py` / `static/editing/image-editor.js` | Image edits, selection context, expansion and mask compositing, and version UI |
| `oneshot/assistant/agent_chat.py` / `oneshot/assistant/chat_service.py` / `static/assistant/agent-chat.js` | Assistant routes, persistent conversations and task queue, and the chat panel |
| `oneshot/assistant/agent_editing.py` / `oneshot/assistant/agent_video.py` | Image editing and video tools that operate on pinned media versions |
| `oneshot/editing/video_remake.py` / `oneshot/editing/video_matte.py` / `static/editing/video-remake.js` | Source analysis, recasting, compositing, shot review, and export with source audio |
| `oneshot/memory/creative_memory.py` / `oneshot/memory/memory_generation.py` / `static/memory/asset-library.js` | Asset library entry point, pinned references and generation context, and the library interface |
| `oneshot/editing/render.py` | Film rendering, transitions, subtitles, music ducking, and narration |
| `oneshot/web/local_admin.py` / `engine.sh` | Local deployment view, GPU/memory/disk status, service controls, and model files |
| `static/index.html` / `static/canvas/` | Workspace markup and styles for the canvas layout, nodes, navigation, and workflows |
| `static/canvas/canvas.js` / `static/canvas/canvas-persistence.js` / `static/canvas/canvas-history.js` | Shared canvas state, revision-aware saves, undo, and redo |
| `static/generation/canvas-generation.js` | Canvas generation settings, job polling, and node version updates |
| `static/canvas/canvas-import.js` / `static/memory/canvas-asset-drawer.js` | File imports and the canvas media drawer |
| `static/canvas/canvas-projects.js` | Canvas switching, samples, and workspace startup |
| `static/generation/storyboard-node.js` / `static/editing/film.js` / `static/generation/wizard.js` | Storyboard script nodes, timeline editor, and Idea to Film |

The browser saves through `/api/board/{id}`. The assistant writes to the same canvas when a tool finishes. Browser saves check the canvas revision. The assistant saves tool results and canvas changes together to prevent duplicate operations.

Image and video requests share the generation routes and job status API. The browser updates nodes for manually submitted jobs, and the backend updates nodes for assistant jobs. The asset library stores character notes, references, and drafts separately. Approving a draft updates the default reference.

## Verification

[Regression commands](docs/agents.en.md#verification-and-review) · [Acceptance history and open checks](docs/verification.en.md)

## License

The OneShot code and project documentation are licensed under the [MIT License](LICENSE).

MiniMax-H3 and H3-Image weights are distributed under the MiniMax H3 Community License. Vendored third-party components retain their original licenses. [Vendor licenses](static/vendor/)
