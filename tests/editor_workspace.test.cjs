// DOM integration checks using one workspace across the end-to-end scenarios.
"use strict";

const { boot, close } = require('./workspace_fixture.cjs');

const scenarios = [
 require('./workspace/workspace-navigation.cjs'),
 require('./workspace/node-arrangement.cjs'),
 require('./workspace/assistant-edits-and-recovery.cjs'),
 require('./workspace/memory-library.cjs'),
 require('./workspace/assistant-choices-and-archive.cjs'),
 require('./workspace/remake-review-and-localization.cjs'),
 require('./workspace/remake-corrections-and-handoff.cjs'),
 require('./workspace/workspace-import-and-projects.cjs'),
 require('./workspace/canvas-sharing-and-showcase.cjs'),
 require('./workspace/previs-camera-and-models.cjs'),
 require('./workspace/previs-lighting-and-export.cjs'),
 require('./workspace/previs-storyboard-guides.cjs'),
 require('./workspace/video-reference-and-segment-edits.cjs'),
 require('./workspace/video-gif-models-and-drafts.cjs'),
 require('./workspace/timeline-playlists-and-audio.cjs'),
 require('./workspace/batch-layout-and-group-generation.cjs'),
 require('./workspace/shot-run-and-continuity.cjs'),
 require('./workspace/selection-batches-and-wizard-motion.cjs'),
 require('./workspace/storyboard-editing-and-media-association.cjs'),
 require('./workspace/pinned-media-and-library-replacement.cjs'),
 require('./workspace/assistant-queue-documents-and-mentions.cjs'),
 require('./workspace/generation-replay-and-connections.cjs'),
 require('./workspace/canvas-live-and-conflicts.cjs'),
 require('./workspace/canvas-documents-and-transcripts.cjs'),
 require('./workspace/image-editing-and-fullscreen-media.cjs'),
 require('./workspace/node-organizing-and-voice-commands.cjs'),
 require('./workspace/assistant-dictation-and-approval.cjs'),
 require('./workspace/assistant-fullscreen-retry-and-memory.cjs'),
 require('./workspace/assistant-task-center.cjs'),
 require('./workspace/creative-apps-and-assistant-context.cjs'),
 require('./workspace/image-layer-workspace.cjs'),
 require('./workspace/story-film-timing.cjs'),
 require('./workspace/generation-adherence.cjs'),
];

async function run() {
 const workspace = await boot();
 if (workspace.englishSmoke) {
  await require('./workspace_localization.cjs')(workspace);
  return;
 }
 const scenarioState = {};
 for (const test of scenarios) await test(workspace, scenarioState);
}

run().catch(error => {
 console.error(error);
 process.exitCode = 1;
}).finally(close);
