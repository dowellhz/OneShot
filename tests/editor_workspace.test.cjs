// DOM integration checks using one workspace across the end-to-end scenarios.
"use strict";

const { boot, close } = require('./workspace_fixture.cjs');
const imageReferenceRemoval = require('./workspace/image-reference-removal.cjs');
const filmDubbing = require('./workspace/film-dubbing.cjs');
const storyDubbing = require('./workspace/story-dubbing.cjs');
const filmMusic = require('./workspace/film-music.cjs');
const wizardMedia = require('./workspace/wizard-media.cjs');
const wizardProduction = require('./workspace/wizard-production.cjs');
const wizardCharacterReference = require('./workspace/wizard-character-reference.cjs');
const wizardSuppliedAssets = require('./workspace/wizard-supplied-assets.cjs');
const generationModelSettings = require('./workspace/version-generation-settings.cjs');
const mediaServicePicker = require('./workspace/media-service-picker.cjs');

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
 generationModelSettings,
 mediaServicePicker,
 filmDubbing,
 storyDubbing,
 filmMusic,
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
 require('./workspace/video-quality.cjs'),
 require('./workspace/wizard-assets.cjs'),
 wizardMedia,
 wizardProduction,
 wizardCharacterReference,
 wizardSuppliedAssets,
 imageReferenceRemoval,
];

async function run() {
 const workspace = await boot();
 if (workspace.englishSmoke) {
  await generationModelSettings(workspace);
  await mediaServicePicker(workspace);
  await filmDubbing(workspace);
  await storyDubbing(workspace);
  await filmMusic(workspace);
  await wizardMedia(workspace);
  await wizardProduction(workspace);
  await wizardCharacterReference(workspace);
  await wizardSuppliedAssets(workspace);
  await imageReferenceRemoval(workspace);
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
