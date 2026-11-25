# Verification notes

Snapshot dated November 24, 2026. The 4090 previously resumed the `0a0fc3d` Web service and H3 engine after a reboot. Subsequent changes are tested in isolated instances. The deployment record on the host identifies the version currently running.

### Coverage and open checks

| Area | Verification |
| --- | --- |
| Multimodal references | `@` references support groups of images, video and audio ranges, and asset text. Tests against an isolated H3 V2 API fixture covered model selection, review before submission, cropped media transfer, and version history. Real-service output and limit messages still need verification. |
| Live voice transcription | Isolated Chrome testing covered microphone permission and denial, recording preview, stop, cancel, interruption, file transcription, and release of the microphone when the assistant closes while retaining the draft. The production 4090 was tested with local Faster Whisper on a Chinese sample for preview, complete transcription, and segment timestamps. Browser microphone access requires HTTPS or a loopback address. |
| Preview and final video variants | A Seedance final can become a version of the preview node or a linked node. Browser tests check that a failed canvas save blocks submission. The Ark API fixture verified recovery of the original job after a Web restart, retrieval of a submitted final after the preview expired, and download of the final file. Verification with the live Seedance service remains open. |
| Video model capabilities | Multimodal routing is implemented for Seedance and cloud MiniMax-H3. H3 model IDs, durations, and resolutions were checked against its API. Mock submissions covered combining a first frame with character images in reference mode and ordinary native first-and-last-frame mode. The 4090 used local H3 for video at the time of this check. Cloud media limits and output tiers still need live testing. [MiniMax H3 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) |

### Local tests and remaining checks

- **Generate to a new node** was tested from an isolated browser against local H3 for both image and video. Each case produced one result. The source node and version stayed intact, and the result could be reopened after refresh. Changing the upstream version during generation kept the submitted version pinned in the result's link and history. The video case included review of the prompt and references before submission.
- Isolated Chromium on the 4090 verified prompt panel dragging and resizing, pinning references by dragging a historical version thumbnail, and inserting an `@` reference with Enter. Two independent browser sessions verified review invitations, joining and leaving collaboration, cursor sharing, following another viewer, canvas updates, and synchronized comments.
- Repeating Shot 1 with the original assets on an isolated 4090 engine produced background passersby in both roughly 14-second runs. In sampled frames from a 5.17-second run, the corridor stayed empty. A three-keyframe variant sometimes introduced camera cuts or repeated motion. [H3 instruction adherence evaluation](video-reference.md#h3-指令依从性验收)
- With cloud routing configured, real-service tests still need to cover grouped image references, explicit model selection, edits and reruns from past versions, and the resulting outputs, histories, and references.

## 4090 release acceptance

- Record the commit or release manifest for the running Web service and engine. Check both services and use a dedicated test canvas. Submit GPU jobs when the queue is idle.
- Make a five-second shot with **Idea to Film**. Set it in an old station after the rain, add references for exactly two characters, and include one explicit line of dialogue. Inspect the script, first/middle/last frames, video preview, and export. Sample between anchors and check cast count, identity, camera position, repeated motion, dialogue, and accidental narration of the prompt.
- Record the effective prompt, model, seed, anchor times, and media references before generating. Change an upstream version, retry with the original parameters, and confirm that the preview, submission, and history use the pinned versions.
- Choose **H3 Ref2VA INT8 ConvRot** with the same anchors and seed, starting with five seconds at 480p. Record idle VRAM and sample GPU VRAM through completion. Record the sampling interval, peak, queue time, execution time, job ID, resolution, actual duration, frame rate, presence of audio, and whether the MP4 decodes through the end. Repeat the baseline successfully before increasing duration or resolution. Record failures and remaining VRAM separately.
- When test credentials are available, verify Seedance draft-to-final and job recovery across service restarts. Check cloud H3 reference limits, grouped inputs, edits from prior versions, and regeneration with the real API.

### 4090 test results (2026-11-25)

After the reboot, the production Web service, H3 engine, and local transcription service passed their checks. The production Web release record identifies `07e4c35`. The runs below used an isolated Web instance at `aacc045` with the production H3 engine. Each run used H3 Ref2VA INT8 ConvRot, seed `8273`, four sampling steps, two character references, and three keyframes. The five-second runs placed the keyframes at 0, 2, and 5 seconds. The eight-second run used 0, 4, and 8 seconds.

| Job | Requested duration | Actual output (864×480, 24 fps) | Submission to completion | Peak VRAM |
| --- | --- | --- | --- | --- |
| `pa7be56e18231` | 5 s | 5.17 s, 124 frames | 43.9 s | 23,771 MiB |
| `pddcf69d703b6` | 5 s | 5.17 s, 124 frames | 39.7 s | 23,797 MiB |
| `p1fde0529a14e` | 8 s | 8.00 s, 192 frames | 61.2 s | 23,771 MiB |

Idle VRAM was 510 MiB, with roughly one sample per second during each run. All three jobs started within about one second, and all video frames and 32 kHz stereo audio decoded to the end. Six frames sampled from the first clip showed exactly two characters, and the timeline exported that clip as a five-second MP4. Transcription of the first and eight-second clips detected only the requested dialogue, “Hello, Crimson.” All 32 isolated regression tests for creative memory, generation replay, and INT8 selection passed. The complete Idea to Film workflow with worldbuilding and repeatability at eight seconds still need live verification.
