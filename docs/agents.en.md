# OneShot Coding Standards and Review Guide

This guide applies to the whole repository. See the [README](../README.md) for the project layout and how to run OneShot. [中文版](../AGENTS.md)

## Layout and dependencies

- `server.py` is the compatibility entry point. Application setup and background service lifecycle live in `oneshot/app.py`. HTTP routes are registered in `oneshot/web/routing.py`, with handlers in their feature modules. Preserve compatibility with `python server.py` and `import server`.
- Backend modules live in `oneshot/`. Use `canvas/` for boards and collaboration, `memory/` for creative memory, `assistant/` for the assistant, `generation/` for generation requests and prompts, `editing/` for media processing, `providers/` for model capabilities and adapters, `storage/` for database access, `web/` for authentication and the console, and `integrations/` for external connections.
- `engine/` runs as a separate GPU process. The web application submits and queries jobs through its existing API. BF16, INT8, and local image jobs share the GPU queue. The engine manages model switching and GPU memory release.
- Use explicit `oneshot` package imports. When a module needs a new dependency, pass the required service or configuration explicitly. Gradually narrow existing dependencies on whole `host` modules and avoid adding cross-package import cycles.
- Resolve runtime directories through `oneshot/config.py` or existing environment variables. When moving files, check paths for `data/`, `models/`, `static/`, fonts, prompt guides, and subprocess entry points. Put developer tools in `scripts/` and tests in `tests/`.
- When moving routes or modules, verify HTTP methods, paths, matching order, permissions, and response contracts. Use the production start command in an isolated directory to test login and affected entry points. Check static assets, subprocesses, and documented operational scripts from their normal entry points. Migrate existing compatibility callers to the feature modules that own their dependencies.

## File size and code style

- **Keep handwritten source and test files at or below 500 lines.** Count physical lines, including blank lines and comments. This applies to Python, JavaScript, HTML, CSS, and similar source files. Third-party and generated files follow their respective maintenance processes.
- If a change takes a file over 500 lines, split it by responsibility before committing. Organize new test cases by feature and reuse existing test utilities.
- **Give each file one main responsibility.** If a file contains features that can be understood, changed, or tested independently, move each feature to its own file along feature and data boundaries, even when the original file is under 500 lines. For video generation, keep clear entry points for prompt preparation, model selection, and job submission and recovery. Give genuinely shared logic a clear home and avoid duplicating it or adding forwarding layers.
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
- A retry with the original settings must reuse the effective prompt, model and provider, generation parameters, and asset versions originally submitted. Complete transformations such as visual worldbuilding extraction and prompt rewriting before taking the snapshot. Test with a stub that can return different results and verify that the retry still submits the original input. Clearly disclose differences when a historical record lacks the required fields.
- For image generation, pass only visible details from worldbuilding and documents that apply to the current shot. Preserve the user's visual description, explicitly requested text, and pinned reference images. When reviewing creative memory changes, check project scope, permissions, and historical snapshots.

## Frontend

- Reuse existing canvas state, request helpers, and controls in `static/`. Put assets in their feature directories. When changing canvas scripts, check the load order and cache versions in `index.html`. Standalone pages can use native ES modules with explicit imports.
- Support saving, undo, and version switching where the action calls for them. Preserve the selected model and pinned inputs during generation. Check loading, failure, cancellation, empty, and read-only states.
- Treat project names, assets, chat content, and model responses as dynamic data. Use `textContent` or existing escaping and sanitization when writing to the DOM. Preserve media authorization and isolation between projects.
- Cover visible copy, help text, and accessibility labels in Chinese and English for UI changes. Check static pages and dynamically rendered content, controls, empty states, and errors after entering the workflow. Store English messages in `static/shared/locales/`. Preserve prompts, work titles, and other user content verbatim.
- Use stable IDs, state fields, and explicit form values in application logic. Localize display fields only. Test nested templates, `data-*` metadata, and submitted option values to ensure translation preserves selectors, state, and request parameters.
- Before switching languages or canvases or reloading, each editor must save or protect the drafts it owns. Drafts include references, pinned versions, selections, and attachments without any text. Recheck current state after waiting for saves. On failure, preserve the edits and show how to recover.

## Verification and review

Run the relevant checks from the repository root. CPU regressions use `requirements-web.txt`. Frontend tests use Node.js 24.15 or a compatible version and install locked dependencies with `npm ci`. GitHub Actions runs the line limit and both regression suites on pushes to main and pull requests.

```bash
git diff --check
python scripts/check_file_lengths.py
python scripts/fetch_editor_models.py --upscale-only
python -m unittest discover -s tests -v
PYTHONPATH=tests python -m unittest test_creative_memory test_memory_generation test_h3_int8 -v
npm ci
npm test
```

- Prioritize normal entry points and scenarios most likely to regress. Use temporary data and mock external services in regression tests. When real model verification is needed, use an isolated instance and the existing GPU queue. Record the model, input settings, results, and any scope left unverified.
- Name tests after the behavior they cover. In asynchronous tests, wait for state changes and record queue time separately from execution time. Clean up jobs and temporary files created by the test when it times out or exits.
- Start reviews with permissions and data exposure, followed by incorrect results, destructive changes, queueing and retries, compatibility, and test coverage. Describe each finding with its trigger, impact, and file location. Sort findings by severity.
- When tests fail, compare against the prior code with the same dependencies and environment. Report the checks actually run, any failures, and their causes. State the limits of verification when dependencies or hardware are missing.
- Check the scope of a commit before creating it. Keep account data, databases, credentials, model weights, logs, and generated media in the runtime environment. Before deploying, verify startup, login, and affected workflows in an isolated instance. Check the production queue and rollback procedure.
- Before deploying, verify the service manager, start and stop commands, and runtime configuration. Confirm how to recreate a transient unit with its existing settings before stopping it. When the deployment serves static assets directly, replace those files and update their cache versions. Verify key pages, assets, and service state through the deployed entry points.
