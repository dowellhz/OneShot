# OneShot Coding Standards and Review Guide

This guide applies to the whole repository. See the [README](../README.md) for the project layout and how to run OneShot. [中文版](../AGENTS.md)

## Layout and dependencies

- `server.py` is the compatibility entry point. Application setup and background service lifecycle live in `oneshot/app.py`. HTTP routes are registered in `oneshot/web/routing.py`, with handlers in their feature modules. Preserve compatibility with `python server.py` and `import server`.
- Backend modules live in `oneshot/`. Use `canvas/` for boards and collaboration, `memory/` for creative memory, `assistant/` for the assistant, `generation/` for generation requests and prompts, `editing/` for media processing, `providers/` for model capabilities and adapters, `storage/` for database access, `web/` for authentication and the console, and `integrations/` for external connections.
- `engine/` runs as a separate GPU process. The web application submits and queries jobs through its existing API. BF16, INT8, and local image jobs share the GPU queue. The engine manages model switching and GPU memory release.
- Use explicit `oneshot` package imports. When a module needs a new dependency, pass the required service or configuration explicitly. Gradually narrow existing dependencies on whole `host` modules and avoid adding cross-package import cycles.
- Resolve runtime directories through `oneshot/config.py` or existing environment variables. When moving files, check paths for `data/`, `models/`, `static/`, fonts, prompt guides, and subprocess entry points. Put developer tools in `scripts/` and tests in `tests/`.

## File size and code style

- **Keep new handwritten source and test files at or below 500 lines.** Count physical lines, including blank lines and comments. This applies to Python, JavaScript, HTML, CSS, and similar source files. Third-party and generated files follow their respective maintenance processes.
- Split existing files over 500 lines by responsibility as they are changed. Put new standalone features in focused modules. For fixes, prioritize extracting the code closely related to the change. An urgent fix may stay in place if the commit records where to split it later.
- Split code along feature and data boundaries. For video generation, keep clear entry points for prompt preparation, model selection, and job submission and recovery. Keep shared logic together. Avoid packing lines, duplicating implementations, or adding forwarding layers to meet the line limit.
- Use four-space indentation in Python. Group imports into standard library, third-party, and repository imports. Follow the surrounding JavaScript and CSS style and limit formatting changes to the code you are working on.
- Add type annotations for key arguments and return values at module boundaries. Follow existing conventions for straightforward internal logic. Clarify units such as frames, seconds, and pixels in field names or interface comments.
- Organize complex conditions into readable steps. Use comments to explain constraints, compatibility decisions, or data provenance. Keep recurring formats, states, and limits in the module that owns the rule.

## Implementation and compatibility

- Choose names that convey the feature's meaning. Reuse existing validation, model routing, media reference resolution, and job state logic. Make function inputs, outputs, and failure behavior clear at the call site.
- At HTTP boundaries, validate request shape, enum values, quantities, ranges, and permissions. Resolve paths through the existing media reference and authorization checks. Validate node, asset, model, and job IDs on the server.
- Set timeouts on network requests. Follow existing patterns for moving expensive CPU, disk, and media work off the event loop. Make cancellations and failures traceable in the UI or task records. Log diagnostic details while excluding credentials and private source material.
- When changing an API or storage schema, check existing boards, historical versions, and jobs awaiting recovery. Give new fields compatible defaults. Preserve error formats and version conflict behavior. For data migrations, verify that existing data can be upgraded.
- Use the settings and asset versions captured when an asynchronous job was submitted. Review duplicate submissions, timeouts, cancellation, retries, and partial failures so jobs do not duplicate, incomplete files do not publish, and saved edits are preserved.
- Check permissions at server-side read and write entry points and reuse existing authorization logic. Define a commit point for multi-step writes and use existing transactions or atomic replacement. Catch exceptions when the handler can recover or add useful context.
- Keep model capabilities and parameter limits in routing or adapter modules. Previews, submissions, and retries should use the same selection. If a model the user chose is unavailable, return an understandable error.
- For image generation, pass only visible details from worldbuilding and documents that apply to the current shot. Preserve the user's visual description, explicitly requested text, and pinned reference images. When reviewing creative memory changes, check project scope, permissions, and historical snapshots.

## Frontend

- Reuse existing canvas state, request helpers, and controls in `static/`. Put assets in their feature directories. When changing canvas scripts, check the load order and cache versions in `index.html`. Standalone pages can use native ES modules with explicit imports.
- Support saving, undo, and version switching where the action calls for them. Preserve the selected model and pinned inputs during generation. Check loading, failure, cancellation, empty, and read-only states.
- Treat project names, assets, chat content, and model responses as dynamic data. Use `textContent` or existing escaping and sanitization when writing to the DOM. Preserve media authorization and isolation between projects.
- Provide Chinese and English labels, actions, and status messages for UI changes. Store English messages in `static/shared/locales/` and use stable IDs, form values, and state fields in application logic. Preserve prompts, work titles, and other user content verbatim.

## Verification and review

Run checks from the repository root according to the scope of the change. Python tests need an environment with `requirements.txt` installed. Frontend interaction tests need Node.js and access to `jsdom`.

```bash
git diff --check
python -m unittest discover -s tests -v
PYTHONPATH=tests python -m unittest test_creative_memory test_h3_int8 -v
node --check static/generation/canvas-generation.js
node tests/editor_workspace.test.cjs
node tests/i18n.test.cjs
```

- Prioritize normal entry points and scenarios most likely to regress. Use temporary data and mock external services in regression tests. When real model verification is needed, use an isolated instance and the existing GPU queue. Record the model, input settings, results, and any scope left unverified.
- Name tests after the behavior they cover. In asynchronous tests, wait for state changes and record queue time separately from execution time. Clean up jobs and temporary files created by the test when it times out or exits.
- Start reviews with permissions and data exposure, followed by incorrect results, destructive changes, queueing and retries, compatibility, and test coverage. Describe each finding with its trigger, impact, and file location. Sort findings by severity.
- When tests fail, compare against the prior code with the same dependencies and environment. Report the checks actually run, any failures, and their causes. State the limits of verification when dependencies or hardware are missing.
- Check the scope of a commit before creating it. Keep account data, databases, credentials, model weights, logs, and generated media in the runtime environment. Before deploying, verify startup, login, and affected workflows in an isolated instance. Check the production queue and rollback procedure.
