"""Keyframes at any frame, together with character references — what ComfyUI's MiniMaxH3AddGuide does.

diffusers' MiniMax-H3 pipeline anchors keyframes only at the first / last frame and only without references (fl2va),
while ref2va takes references only. Both feed the same "condition rows" to the transformer (VAE latents noised to
t = 0.999 and held there, never stepped); they differ only in where those rows sit on the rotary clock:

  * a reference image: its own time slot between the text and the target, on its own spatial grid;
  * a keyframe (ComfyUI `MiniMaxH3AddGuide`): the target's spatial grid, at time
        target_origin + 5/3 · pixel_frame_index
    where target_origin is where the generated video's timeline starts (after the references' slots).

So a keyframe is passed to ref2va as an extra image reference (the frame cropped to the target canvas, so the VAE
encodes it as one target-sized latent frame) appended after the real references, and three things are patched:
  1. the text encoder sees only the real references (ComfyUI does not show guides to Qwen);
  2. the ref2va layout puts the appended rows on the target timeline at their frame instead of giving them a slot;
  3. nothing else: the condition-latent noising and the denoise loop already treat them as condition rows.
`ACTIVE` carries the request's keyframes from the engine into the patched steps (one job at a time).
"""
from __future__ import annotations

import torch

ACTIVE = {"n_refs": None, "frames": []}      # n_refs: how many leading references are real; frames: pixel frame per keyframe
_patched = False


def set_active(n_refs: int | None, frames: list[int]):
    ACTIVE["n_refs"], ACTIVE["frames"] = n_refs, list(frames)


def crop_to_canvas(image, width: int, height: int):
    """Center-crop + Lanczos resize to the target canvas (ComfyUI `_resize(..., "center")`)."""
    from PIL import Image
    w, h = image.size
    s = max(width / w, height / h)
    nw, nh = max(width, round(w * s)), max(height, round(h * s))
    im = image.convert("RGB").resize((nw, nh), Image.LANCZOS)
    x, y = (nw - width) // 2, (nh - height) // 2
    return im.crop((x, y, x + width, y + height))


def install():
    global _patched
    if _patched:
        return
    from diffusers.modular_pipelines.minimax_h3 import before_denoise as bd
    from diffusers.modular_pipelines.minimax_h3 import before_encoder as be
    from diffusers.modular_pipelines.minimax_h3 import encoders as enc

    # 0. keyframes are not references: the 9-image / 12-total caps apply to the real references only
    setup = be.MiniMaxH3Ref2VASetupStep
    orig_setup = setup.__call__

    def setup_call(self, components, state):
        extra = len(ACTIVE["frames"]) if ACTIVE["n_refs"] is not None else 0
        saved = self.max_images, self.max_references
        self.max_images, self.max_references = saved[0] + extra, saved[1] + extra
        try:
            return orig_setup(self, components, state)
        finally:
            self.max_images, self.max_references = saved
    setup.__call__ = setup_call

    # 1. text encoder: only the real references are presented to Qwen
    step = enc.MiniMaxH3Ref2VATextEncoderStep
    orig_call = step.__call__

    def text_call(self, components, state):
        n = ACTIVE["n_refs"]
        refs = state.get("normalized_references")
        if n is None or refs is None or n >= len(refs):
            return orig_call(self, components, state)
        state.set("normalized_references", list(refs[:n]))
        try:
            return orig_call(self, components, state)
        finally:
            state.set("normalized_references", refs)
    step.__call__ = text_call

    # 2. layout: references after the first n_refs are keyframes on the target timeline
    def build(text_token_tags, references, condition_latents, audio_condition_latents, num_latent_frames,
              latent_height, latent_width, num_audio_latents, patch_size, audio_channels, audio_tag, video_tag):
        n_refs = ACTIVE["n_refs"]
        kf_frames = ACTIVE["frames"]
        _, patch_h, patch_w = patch_size
        num_text_tokens = text_token_tags.shape[0]
        num_target_video_rows = num_latent_frames * (latent_height // patch_h) * (latent_width // patch_w)
        num_target_audio_rows = num_audio_latents * audio_channels
        geometries = [tuple(latents.shape[2:5]) for latents in condition_latents]
        visual_geometry = iter(geometries)
        audio_row_counts = iter(rows.shape[0] for rows in audio_condition_latents)
        num_reference_video_rows = sum(f * (h // patch_h) * (w // patch_w) for f, h, w in geometries)
        num_reference_audio_rows = sum(rows.shape[0] for rows in audio_condition_latents)
        sequence_length = num_text_tokens + num_reference_video_rows + num_reference_audio_rows + num_target_audio_rows + num_target_video_rows
        position_ids = torch.zeros(sequence_length, 3, dtype=torch.float64)
        position_ids[:num_text_tokens, 0] = torch.arange(num_text_tokens, dtype=torch.float64)
        target_frame_grid, target_width_grid = bd._frame_position_grid(latent_height, latent_width, patch_h, patch_w)
        video_indices, audio_indices = [], []
        cursor = num_text_tokens
        rotary_time = float(num_text_tokens)
        for index, reference in enumerate(references):
            keyframe = n_refs is not None and index >= n_refs
            if reference.kind == "image":
                f_, rh, rw = next(visual_geometry)
                n = f_ * (rh // patch_h) * (rw // patch_w)
                rows = slice(cursor, cursor + n)
                cursor = rows.stop
                video_indices.append(torch.arange(rows.start, rows.stop))
                frame_grid, _ = bd._frame_position_grid(rh, rw, patch_h, patch_w)
                if keyframe:
                    # the keyframes come after every real reference, so rotary_time is already the target origin here
                    k = index - n_refs
                    position_ids[rows, 0] = rotary_time + bd._ROPE_FRAME_RESCALE * float(kf_frames[k])
                    position_ids[rows, 1:] = frame_grid.repeat(f_, 1)
                else:
                    position_ids[rows, 0] = rotary_time
                    position_ids[rows, 1:] = frame_grid
                    rotary_time += 1.0
            elif reference.kind == "audio":
                num_audio_rows = next(audio_row_counts)
                ref_audio = num_audio_rows // audio_channels
                rows = slice(cursor, cursor + num_audio_rows)
                cursor = rows.stop
                audio_indices.append(torch.arange(rows.start, rows.stop))
                bd._fill_audio_positions(position_ids, rows, ref_audio, rotary_time, target_width_grid, audio_channels)
                rotary_time += float(ref_audio)
            elif reference.kind == "video":
                num_audio_rows = next(audio_row_counts) if reference.has_audio else 0
                ref_audio = num_audio_rows // audio_channels
                f_, rh, rw = next(visual_geometry)
                n = f_ * (rh // patch_h) * (rw // patch_w)
                audio_rows = slice(cursor, cursor + num_audio_rows)
                video_rows = slice(audio_rows.stop, audio_rows.stop + n)
                cursor = video_rows.stop
                audio_indices.append(torch.arange(audio_rows.start, audio_rows.stop))
                video_indices.append(torch.arange(video_rows.start, video_rows.stop))
                frame_grid, width_grid = bd._frame_position_grid(rh, rw, patch_h, patch_w)
                bd._fill_audio_positions(position_ids, audio_rows, ref_audio, rotary_time, width_grid, audio_channels)
                frame_time = bd._temporal_position_grid(f_, rotary_time)
                position_ids[video_rows, 0] = frame_time.repeat_interleave(frame_grid.shape[0])
                position_ids[video_rows, 1:] = frame_grid.repeat(f_, 1)
                span = sum(bd._ROPE_FRAME_RESCALE * bd._ROPE_FRAMES_PER_LATENT[i % len(bd._ROPE_FRAMES_PER_LATENT)] for i in range(f_))
                rotary_time += max(float(ref_audio), span)
            else:
                raise ValueError(f"A reference must be an 'image', a 'video' or an 'audio', got {reference.kind!r}.")
        audio_start = cursor
        video_start = audio_start + num_target_audio_rows
        bd._fill_audio_positions(position_ids, slice(audio_start, video_start), num_audio_latents, rotary_time,
                                 target_width_grid, audio_channels)
        frame_time = bd._temporal_position_grid(num_latent_frames, rotary_time)
        position_ids[video_start:, 0] = frame_time.repeat_interleave(target_frame_grid.shape[0])
        position_ids[video_start:, 1:] = target_frame_grid.repeat(num_latent_frames, 1)
        video_indices = torch.cat(video_indices + [torch.arange(video_start, sequence_length)])
        audio_indices = torch.cat(audio_indices + [torch.arange(audio_start, video_start)])
        text_indices = torch.arange(num_text_tokens)
        token_tags = torch.empty(sequence_length, dtype=torch.long)
        token_tags[text_indices] = text_token_tags.to(torch.long)
        token_tags[audio_indices] = audio_tag
        token_tags[video_indices] = video_tag
        return position_ids, token_tags, video_indices, audio_indices, text_indices, num_reference_video_rows, num_reference_audio_rows

    bd.MiniMaxH3Ref2VAPrepareLayoutStep.build_ref2va_packed_sequence = staticmethod(build)
    _patched = True
