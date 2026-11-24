#!/usr/bin/env python3
"""OneShot: AI video studio — canvas, 一句话成片 wizard, 剪辑台, console; local H3 engine and third-party models.

Builds ComfyUI API graphs for H3 text-to-image, text/first/last-frame-to-video (FL2VA) and keyframe/reference video
(Ref2VA), tracks the jobs over ComfyUI's websocket, and keeps the board in data/board.json.
"""
import asyncio, copy, io, json, math, os, random, re, secrets, tempfile, time, uuid, hashlib, zipfile
from pathlib import Path
from contextlib import ExitStack
from xml.etree.ElementTree import ParseError

import aiohttp
from urllib.parse import quote, unquote
from PIL.Image import DecompressionBombError

import rewriter
import fields as pfields
import tools
import render as film
import broll
import tts
import audio_separation
import audio_waveform
import db
import auth
import providers
import remote
import local_admin
import image_editor
import image_upscale
import image_camera
import motion_reference
import camera_plan
import object_edit
import previs
import agent_chat
import creative_memory
import canvas_live
import board_store
import document_review
import public_canvas
import shared_canvas_items
import showcase
import creative_events
import generation_watermark
import asset_transfers
import mcp_bridge
import connector_oauth
import video_remake
import video_prompt_adapters
import workflow_presets
import workflow_review
from board_store import BOARD_ID as _ID, access_role, board_meta, can_edit, can_see
import sys
from aiohttp import web

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
PORT = int(os.environ.get("H3STUDIO_PORT", "8190"))
ROOT = Path(__file__).resolve().parent
IMAGE_UPSCALE_MODELS = Path(os.environ.get("IMAGE_UPSCALE_MODELS", ROOT / "models" / "upscale"))
DATA = ROOT / "data"
COMFY_DIR = Path(os.environ.get("COMFY_DIR", str(Path.home() / "ComfyUI")))
CLIENT_ID = "h3studio-" + uuid.uuid4().hex[:8]

M = {
    "fl2va": "minimax_h3_fl2va_bf16.safetensors",
    "ref2va": "minimax_h3_ref2va_bf16.safetensors",
    "clip": "qwen3vl_32b_minimax_h3_bf16.safetensors",
    "vae": "minimax_h3_video_vae_fp16.safetensors",
    "avae": "minimax_h3_audio_vae_fp32.safetensors",
    "lora8": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
    "lora768": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
    "lora_ref": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    "image": "minimax_h3_image_pruned_bf16.safetensors",
    "image_vae": "minimax_h3_image_vae_fp16.safetensors",
    "pe": "qwen3.5_9b_w4a8_gptq.safetensors",
}
TEMPLATES = ROOT / "templates"

# ---------------------------------------------------------------- helpers

def size_for(ar: float, megapixels: float, multiple: int = 32):
    """ComfyUI ResolutionSelector's rule: megapixels of 1024*1024, sides rounded to the multiple."""
    px = megapixels * 1024 * 1024
    w = math.sqrt(px * ar)
    h = w / ar
    return max(multiple, round(w / multiple) * multiple), max(multiple, round(h / multiple) * multiple)


def frames_for(seconds: float) -> int:
    n = max(5, round(seconds * 24))
    return n + (5 - n % 17) % 17   # H3's 17k+5 frame grid


def engine_video_frames(seconds: float) -> int:
    return min(345, max(124, frames_for(seconds)))


def load_name(ref: str) -> str:
    """'input:sub/x.png' -> 'sub/x.png'; 'output:sub/x.png' -> 'sub/x.png [output]' (LoadImage's annotated names)."""
    try:
        tools.ref_path(COMFY_DIR, ref)
    except ValueError:
        raise web.HTTPBadRequest(text="bad image reference")
    kind, path = ref.split(":", 1)
    return path if kind == "input" else f"{path} [output]"


def seed_of(v) -> int:
    try:
        v = int(v)
    except (TypeError, ValueError):
        v = -1
    return v if v >= 0 else random.randrange(1, 2**48)


def ts(sec: float) -> str:
    return f"00:{int(sec):02d}.{int(round((sec - int(sec)) * 1000)):03d}"


def clean(s) -> str:
    return " ".join(str(s or "").split()) if s else ""


# ---------------------------------------------------------------- graphs

H3IMG_IDS = {
    True: {"unet": "29", "clip": "30", "vae": "31", "cond": "32", "zero": "33", "pe": "34", "pe_clip": "35", "sys": "36",
           "preview": "37", "ks": "38", "task": "39", "repl": "40", "sw": "41", "dec": "42", "user": "43", "json": "44"},
    False: {"unet": "23:1", "clip": "23:2", "vae": "23:3", "cond": "23:5", "zero": "23:6", "pe": "23:15", "pe_clip": "23:16",
            "sys": "23:17", "preview": "23:18", "ks": "23:7", "task": "23:20", "repl": "23:19", "sw": "23:22", "dec": "23:8",
            "user": "23:24", "json": "23:26"},
}

SOUND_DEFAULT = "Natural ambient sound that matches the scene, with physical sounds synchronized to every visible action."


def base_structure(prompt: str, frame_times, seconds: float, sound: str, music: str) -> str:
    """The official T2VA/I2VA/FL2VA/L2VA layout around the user's words (kept as they are when already structured)."""
    align = rewriter.alignment_line(frame_times, seconds)
    if "integrated_multimodal_description:" in prompt:
        body = prompt[prompt.index("integrated_multimodal_description:"):]
    else:
        body = (f"integrated_multimodal_description: [Shot 1] {prompt}\n\noverall_soundscape: {clean(sound) or SOUND_DEFAULT}"
                f"\n\nnon_diegetic_music: {clean(music) or 'N/A'}")
    return (align + "\n\n" + body) if align else body


def graph_h3image(p: dict):
    """MiniMax H3-Image: text-to-image, or editing / multi-reference when images come in (<Picture n> = image n)."""
    imgs = p.get("images") or []
    edit = bool(imgs)
    t = json.loads((TEMPLATES / ("h3image_edit.json" if edit else "h3image_t2i.json")).read_text())
    g = {k: v for k, v in t.items()}
    ids = H3IMG_IDS[edit]
    seed = seed_of(p.get("seed"))
    mp = {"4mp": 4.0, "16mp": 16.0}.get(p.get("quality"), 4.0)
    prompt = re.sub(r"@图(\d+)", lambda m: f"<Picture {m.group(1)}>", p["prompt"].strip())
    pe = bool(p.get("expand", False))
    g[ids["unet"]]["inputs"]["unet_name"] = M["image"]
    g[ids["clip"]]["inputs"]["clip_name"] = M["clip"]
    g[ids["vae"]]["inputs"]["vae_name"] = M["image_vae"]
    g[ids["pe_clip"]]["inputs"]["clip_name"] = M["pe"]
    g[ids["ks"]]["inputs"]["seed"] = seed
    g[ids["user"]]["inputs"]["value"] = prompt
    g[ids["pe"]]["inputs"]["sampling_mode.seed"] = seed % (2**31)
    # the prompt expander streams its weights over PCIe at ~3 tokens/s here: no thinking, a short answer
    g[ids["pe"]]["inputs"]["thinking"] = False
    g[ids["pe"]]["inputs"]["max_length"] = 1024
    for k in ("9", "62", "14"):
        g.pop(k, None)
    g["save"] = {"class_type": "SaveImage", "inputs": {"filename_prefix": "h3studio/img", "images": [ids["dec"], 0]}}
    if edit:
        for k in ("45", "48", "50", "56"):
            g.pop(k)
        cond, pe_in = g[ids["cond"]]["inputs"], g[ids["pe"]]["inputs"]
        for k in [k for k in cond if k.startswith("images.")]: cond.pop(k)
        for k in [k for k in pe_in if k.startswith("images.")]: pe_in.pop(k)
        for i, im in enumerate(imgs[:9]):
            g[f"load{i}"] = {"class_type": "LoadImage", "inputs": {"image": load_name(im["ref"])}}
            g[f"px{i}"] = {"class_type": "ResizeImageMaskNode", "inputs": {"resize_type": "scale total pixels", "resize_type.megapixels": 4,
                                                                          "scale_method": "area", "input": [f"load{i}", 0]}}
            g[f"m32{i}"] = {"class_type": "ResizeImageMaskNode", "inputs": {"resize_type": "scale to multiple", "resize_type.multiple": 32,
                                                                           "scale_method": "area", "input": [f"px{i}", 0]}}
            cond[f"images.image_{i+1}"] = [f"m32{i}", 0]
            pe_in[f"images.image{i+1}"] = [f"m32{i}", 0]
        # the canvas sends image 1's ratio when the ratio follows it; 0 lets the node follow image 1 at 4 MP
        w, h = size_for(float(p["ar"]), mp) if p.get("ar") else (0, 0)
        cond["width"], cond["height"] = w, h
    else:
        w, h = size_for(float(p.get("ar") or 1.0), mp)
        g[ids["cond"]]["inputs"]["width"], g[ids["cond"]]["inputs"]["height"] = w, h
    if not pe:   # the user's words go straight to the conditioning
        for k in ("pe", "pe_clip", "sys", "task", "repl", "json", "sw"):
            g.pop(ids[k], None)
        g[ids["preview"]]["inputs"]["source"] = [ids["user"], 0]
    return g, {"seed": seed, "width": w, "height": h, "steps": 6, "mode_name": ("图像编辑" if edit else "H3-Image") + (" · 扩写" if pe else "")}


def graph_image(p: dict):
    if p.get("model", "h3img") != "h3video":
        return graph_h3image(p)
    ar = float(p.get("ar") or 16 / 9)
    w, h = size_for(ar, {"std": 1.0, "hd": 2.0}.get(p.get("quality"), 1.0), 16)
    turbo = bool(p.get("turbo", True))
    seed = seed_of(p.get("seed"))
    steps = 8 if turbo else 30
    model = ["1", 0]
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": M["fl2va"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M["clip"], "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": re.sub(r"@\S+\d+", "", p["prompt"]).strip(), "clip": ["2", 0]}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
    }
    if turbo:
        g["6"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": M["lora8"], "strength_model": 1.0}}
        model = ["6", 0]
    g.update({
        "7": {"class_type": "ModelAttentionBackend", "inputs": {"attention": "comfy kitchen attention", "model": model}},
        "8": {"class_type": "BasicGuider", "inputs": {"model": ["7", 0], "conditioning": ["4", 0]}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "11": {"class_type": "BasicScheduler", "inputs": {"scheduler": "simple", "steps": steps, "denoise": 1.0, "model": ["7", 0]}},
        "12": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["8", 0], "sampler": ["10", 0], "sigmas": ["11", 0], "latent_image": ["5", 0]}},
        "13": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["12", 0]}},
        "14": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["3", 0]}},
        "15": {"class_type": "SaveImage", "inputs": {"filename_prefix": "h3studio/img", "images": ["14", 0]}},
    })
    return g, {"seed": seed, "width": w, "height": h, "steps": steps}


def ref2va_prompt(prompt: str, captions, times, mode: str) -> str:
    n = len(captions)
    cap = [clean(c) or "the scene" for c in captions]
    if mode == "reference":
        subj = "\n".join(f"<Subject {i+1}> is the main subject in <Picture {i+1}>, showing {cap[i]}." for i in range(n))
        keep = "\n".join(f"<Subject {i+1}>: fully_preserved - its appearance, colors and outfit stay identical to <Picture {i+1}>." for i in range(n))
        return (f"subject_definitions:\n{subj}\n\nsummary:\n[reference generation] {prompt}\n\n"
                f"retention_analysis:\n{keep}\n\ndetailed_description:\n[Shot 1] {prompt}")
    lines = [f"<Subject 1> is the main subject in <Picture 1>.",
             f"<Picture 1> is the first frame of [Shot 1], showing {cap[0]}."]
    lines += [f"<Picture {i+1}> is the keyframe of [Shot 1], showing {cap[i]}." for i in range(1, n)]
    steps = "".join(f" At {ts(times[i])} the shot matches <Picture {i+1}>: {cap[i]}." for i in range(1, n))
    keep = [f"<Subject 1> (appears in [Shot 1]): fully_preserved - the subject's appearance stays identical throughout.",
            "<Picture 1> ([Shot 1] first frame): fully_preserved - the video starts exactly from <Picture 1>."]
    keep += [f"<Picture {i+1}> ([Shot 1] keyframe): fully_preserved - reached at {ts(times[i])}." for i in range(1, n)]
    return ("subject_definitions:\n" + "\n".join(lines) + "\n\nsummary:\n[keyframe completion + reference generation] "
            f"One continuous shot. {prompt} It begins with <Picture 1>"
            + "".join(f", then matches <Picture {i+1}>" for i in range(1, n)) + ".\n\nretention_analysis:\n" + "\n".join(keep)
            + f"\n\ndetailed_description:\n[Shot 1] The shot begins from <Picture 1>. {prompt}{steps}")


def is_character_reference(image):
    return image.get("role") == "subject" and image.get("memory_kind") in (None,"character")


def planned_prompt(prompt: str, subj, frames, end: float) -> str:
    """Ref2VA's structured prompt for character references (<Picture 1..S>) and timed frames (<Picture S+1..>)."""
    S = len(subj)
    lines, keep, steps = [], [], ""
    bundles = {}
    for k, im in enumerate(subj, 1):
        asset = im.get("memory_id") if im.get("memory_bundle") else None
        number = bundles.setdefault(asset, k) if isinstance(asset, str) and asset else k
        if number != k:
            lines.append(f"<Picture {k}> is an additional view of the same <Subject {number}>.")
            continue
        cap = clean(im.get("caption"))
        subject = {"scene": "environment", "prop": "object", "style": "visual style"}.get(im.get("memory_kind"), "character")
        lines.append(f"<Subject {k}> is the {subject} in <Picture {k}>" + (f", {cap}." if cap else "."))
        features = "visual style, colors and lighting" if subject == "visual style" else "layout, materials, colors and visual details" if subject != "character" else "face, body shape, colors and outfit"
        keep.append(f"<Subject {k}>: fully_preserved - the {features} of <Subject {k}> stay identical to <Picture {k}> throughout.")
    for j, im in enumerate(frames):
        pn, t, cap = S + j + 1, float(im["time"]), clean(im.get("caption")) or "the scene"
        kind = "first frame" if t <= 0.01 else ("last frame" if t >= end - 0.05 else "keyframe")
        lines.append(f"<Picture {pn}> is the {kind} of [Shot 1], showing {cap}.")
        keep.append(f"<Picture {pn}> ([Shot 1] {kind}): fully_preserved - " + ("the video starts exactly from it." if kind == "first frame" else f"reached at {ts(t)}."))
        if kind != "first frame":
            steps += f" At {ts(t)} the shot matches <Picture {pn}>."
    tag = "[keyframe completion + reference generation]" if frames else "[reference generation]"
    start = " The shot begins from <Picture %d>." % (S + 1) if frames and float(frames[0]["time"]) <= 0.01 else ""
    if frames and any(is_character_reference(image) for image in subj):
        keep.append("People shown in the keyframes and their corresponding character references share the same identity. "
                    "Keep one on-screen instance per character unless the shot explicitly calls for duplicates.")
    return (f"subject_definitions:\n" + "\n".join(lines) + f"\n\nsummary:\n{tag} {prompt}\n\nretention_analysis:\n" + "\n".join(keep)
            + f"\n\ndetailed_description:\n[Shot 1]{start} {prompt}{steps}")


def graph_video_planned(p: dict):
    imgs = p.get("images") or []
    seconds = min(15.0, max(2.0, float(p.get("duration") or 5)))
    length = frames_for(seconds)
    end = (length - 4) / 24
    hd = p.get("quality", "hd") == "hd"
    w, h = size_for(float(p.get("ar") or 16 / 9), 1.0 if hd else 0.4)
    turbo = bool(p.get("turbo", True))
    seed = seed_of(p.get("seed"))
    subj = [im for im in imgs if im["role"] == "subject"][:9]
    frames = sorted([im for im in imgs if im["role"] != "subject"], key=lambda im: float(im.get("time", 0)))
    # @图k (the k-th input on the canvas) -> its picture number
    pic = {}
    for k, im in enumerate(subj): pic[im["index"]] = k + 1
    for j, im in enumerate(frames): pic[im["index"]] = len(subj) + j + 1
    prompt = re.sub(r"@图(\d+)", lambda m: f"<Picture {pic[int(m.group(1))]}>" if int(m.group(1)) in pic else m.group(0), p["prompt"].strip())
    if "subject_definitions:" in prompt:
        full = prompt[prompt.index("subject_definitions:"):]
    else:
        full = (planned_prompt(prompt, subj, frames, end) + f"\n\noverall_soundscape:\n{clean(p.get('sound')) or SOUND_DEFAULT}"
                f"\n\nnon_diegetic_music:\n{clean(p.get('music')) or 'N/A'}")
    lora, steps = (M["lora_ref"], 4) if turbo else (None, 20)
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": M["ref2va"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M["clip"], "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M["vae"]}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": M["avae"]}},
    }
    model = ["1", 0]
    if lora:
        g["6"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": lora, "strength_model": 1.0}}
        model = ["6", 0]
    refs = {}
    for k, im in enumerate(subj):
        g[f"s{k}"] = {"class_type": "LoadImage", "inputs": {"image": load_name(im["ref"])}}
        refs[f"ref_images.ref_image_{k}"] = [f"s{k}", 0]
    g["5"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
        "clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0], "prompt": full, "width": w, "height": h,
        "length": length, "ref_image_size": "match", **refs}}
    cond, latent = ["5", 0], ["5", 1]
    for j, im in enumerate(frames):
        g[f"f{j}"] = {"class_type": "LoadImage", "inputs": {"image": load_name(im["ref"])}}
        g[f"guide{j}"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
            "positive": cond, "latent": latent, "vae": ["3", 0], "audio_vae": ["4", 0], "image": [f"f{j}", 0],
            "frame_idx": max(0, min(length - 4, round(float(im["time"]) * 24)))}}
        cond = [f"guide{j}", 0]
    g.update({
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "9": {"class_type": "BasicScheduler", "inputs": {"model": model, "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "10": {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": cond}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["7", 0], "guider": ["10", 0], "sampler": ["8", 0], "sigmas": ["9", 0], "latent_image": latent}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
        "14": {"class_type": "CreateVideo", "inputs": {"images": ["12", 0], "audio": ["13", 0], "fps": 24}},
        "15": {"class_type": "SaveVideo", "inputs": {"video": ["14", 0], "filename_prefix": "h3studio/video", "format": "auto", "codec": "auto"}},
    })
    name = ("人物设定" if subj else "") + (" + " if subj and frames else "") + (f"{len(frames)} 张关键帧" if frames else "")
    return g, {"seed": seed, "width": w, "height": h, "steps": steps, "frames": length, "mode": "planned", "mode_name": name,
               "full_prompt": full}


NO_SPEECH = ("No one speaks: there is no dialogue, narration, voiceover or singing, and every character's mouth stays "
             "closed except while eating or drinking.")
NO_SPEECH_SOUND = "No human speech, narration or voices of any kind."
_SECTION = re.compile(r"\n\n[a-z_]+:")


def _append_to_section(full: str, names, text: str) -> tuple[str, bool]:
    for name in names:
        m = re.search(rf"(^|\n){name}:", full)
        if not m:
            continue
        nxt = _SECTION.search(full, m.end())
        end = nxt.start() if nxt else len(full)
        body = full[:end].rstrip()
        sep = "" if body.endswith(":") else " "
        return body + sep + text + full[end:], True
    return full, False


def no_speech_guard(full: str) -> str:
    """H3 makes sound with the picture; a prompt with no <d> dialogue must say nobody talks, or the model may voice the text."""
    if "<d>" in full:
        return full
    full, _ = _append_to_section(full, ("detailed_description", "integrated_multimodal_description"), NO_SPEECH)
    full, ok = _append_to_section(full, ("overall_soundscape",), NO_SPEECH_SOUND)
    if not ok:
        full = full.rstrip() + f"\n\noverall_soundscape:\n{SOUND_DEFAULT} {NO_SPEECH_SOUND}"
    return full


def graph_video(p: dict):
    g, meta = _graph_video(p)
    full = meta["full_prompt"]
    if p.get("_preserve_speech_motion") is not True:
        full = no_speech_guard(full)
    if "5" in g and "prompt" in g["5"].get("inputs", {}):
        g["5"]["inputs"]["prompt"] = full
    meta["full_prompt"] = full
    return g, meta


def _graph_video(p: dict):
    if p.get("planned"):
        return graph_video_planned(p)
    imgs = p.get("images") or []
    n = len(imgs)
    mode = p.get("mode") or "auto"
    if mode == "auto":
        mode = "fl2v" if n <= 2 else "keyframes"
    if mode == "fl2v" and n > 2:
        imgs, n = [imgs[0], imgs[-1]], 2
    if mode in ("keyframes", "reference") and n == 0:
        mode = "fl2v"
    seconds = min(15.0, max(2.0, float(p.get("duration") or 5)))
    length = frames_for(seconds)
    hd = p.get("quality", "hd") == "hd"
    ar = float(p.get("ar") or 16 / 9)
    w, h = size_for(ar, 1.0 if hd else 0.4)
    turbo = bool(p.get("turbo", True))
    seed = seed_of(p.get("seed"))
    ref = mode in ("keyframes", "reference")
    prompt = p["prompt"].strip()
    if ref:   # @图k -> <Picture k>, the reference pipeline's names
        prompt = re.sub(r"@图(\d+)", lambda m: f"<Picture {m.group(1)}>", prompt)
    else:
        prompt = re.sub(r"@图(\d+)", lambda m: "the first frame" if m.group(1) == "1" else (
            "the last frame" if int(m.group(1)) == n else m.group(0)), prompt)
    if turbo:
        lora, steps = (M["lora_ref"], 4) if ref else ((M["lora768"], 4) if hd else (M["lora8"], 8))
    else:
        lora, steps = None, 20
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": M["ref2va" if ref else "fl2va"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M["clip"], "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M["vae"]}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": M["avae"]}},
    }
    model = ["1", 0]
    if lora:
        g["6"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": lora, "strength_model": 1.0}}
        model = ["6", 0]
    for i, im in enumerate(imgs):
        g[f"img{i}"] = {"class_type": "LoadImage", "inputs": {"image": load_name(im["ref"])}}
    times = []
    if not ref:
        times = [0.0] if n == 1 else ([0.0, seconds] if n >= 2 else [])
        prompt = base_structure(prompt, times, seconds, p.get("sound"), p.get("music"))
        times = []
        inp = {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt, "width": w, "height": h, "length": length}
        if n >= 1: inp["first_frame"] = ["img0", 0]
        if n >= 2: inp["last_frame"] = [f"img{n-1}", 0]
        g["5"] = {"class_type": "MiniMaxH3ImageToVideo", "inputs": inp}
        cond, latent = ["5", 0], ["5", 1]
        full_prompt = prompt
    else:
        caps = [im.get("caption") or "" for im in imgs]
        if mode == "keyframes":
            last = (length - 4) / 24
            times = [last * i / (n - 1) for i in range(n)]
            full_prompt = ref2va_prompt(prompt, caps, times, mode)
            refs = {"ref_images.ref_image_0": ["img0", 0]}
        else:
            full_prompt = ref2va_prompt(prompt, caps, [], mode)
            refs = {f"ref_images.ref_image_{i}": [f"img{i}", 0] for i in range(min(n, 9))}
        g["5"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
            "clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0], "prompt": full_prompt, "width": w, "height": h,
            "length": length, "ref_image_size": "match", **refs}}
        cond, latent = ["5", 0], ["5", 1]
        if mode == "keyframes":
            for i in range(1, n):
                g[f"guide{i}"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
                    "positive": cond, "latent": latent, "vae": ["3", 0], "audio_vae": ["4", 0], "image": [f"img{i}", 0],
                    "frame_idx": min(length - 4, round(times[i] * 24))}}
                cond = [f"guide{i}", 0]
    g.update({
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "9": {"class_type": "BasicScheduler", "inputs": {"model": model, "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "10": {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": cond}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["7", 0], "guider": ["10", 0], "sampler": ["8", 0], "sigmas": ["9", 0], "latent_image": latent}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
        "14": {"class_type": "CreateVideo", "inputs": {"images": ["12", 0], "audio": ["13", 0], "fps": 24}},
        "15": {"class_type": "SaveVideo", "inputs": {"video": ["14", 0], "filename_prefix": "h3studio/video", "format": "auto", "codec": "auto"}},
    })
    names = {"fl2v": ["文生视频", "首帧生视频", "首尾帧生视频"][min(n, 2)], "keyframes": f"{n} 张关键帧", "reference": f"{n} 张主体参考"}
    return g, {"seed": seed, "width": w, "height": h, "steps": steps, "frames": length, "mode": mode,
               "mode_name": names[mode], "times": [round(t, 2) for t in times], "full_prompt": full_prompt}


# ---------------------------------------------------------------- jobs

JOBS: dict = {}   # prompt_id -> state
EDIT_JOBS = DATA / "image-edits"


def attach_image_edit(j, p):
    spec = p.get("_image_edit")
    if spec:
        j["meta"]["image_edit"] = spec
        recipe = spec.get("recipe") or {}
        mode_name = {"region":"局部重绘","whole":"整图编辑","outpaint":"智能扩图"}[spec["mode"]]
        if recipe.get("camera_view"):
            mode_name = "图片换机位"
        elif recipe.get("relight"):
            mode_name = "图片重新布光"
        j["meta"]["mode_name"] = mode_name
        if spec.get("recipe", {}).get("backend") == "native":
            j["meta"]["mode_name"] += " · 原生遮罩"
        EDIT_JOBS.mkdir(parents=True, exist_ok=True)
        path = EDIT_JOBS / (j["id"] + ".json")
        tmp = path.with_suffix(".tmp"); tmp.write_text(json.dumps(spec, ensure_ascii=False)); tmp.replace(path)


def restore_image_edit(j):
    # Also keep region protection when recovering an engine/ComfyUI job after restart.
    if re.fullmatch(r"[\w-]{1,80}", j["id"]):
        path = EDIT_JOBS / (j["id"] + ".json")
        if path.is_file():
            attach_image_edit(j, {"_image_edit": json.loads(path.read_text())})


async def complete_outputs(j, outputs):
    async with j.setdefault("_output_lock", asyncio.Lock()):
        if j["state"] in ("done", "error"):
            return
        error_label = "图像编辑合成失败"
        try:
            spec = j.get("meta", {}).get("image_edit")
            if spec:
                j["phase"] = "compositing"
                if spec.get("recipe") is not None:
                    spec["recipe"]["seed"] = j["meta"].get("seed", spec["recipe"].get("seed", -1))
                outputs = await asyncio.to_thread(image_editor.composite, COMFY_DIR, spec, outputs)
            if outputs and not j.get("cancel") and db.one("SELECT 1 FROM task_watermarks WHERE job_id=?",j["id"]):
                j["phase"] = "watermark"
                error_label = "写入 AI 生成水印失败"
                labelled = await asyncio.to_thread(generation_watermark.label_outputs,
                    COMFY_DIR,j["id"],j["kind"],outputs,lambda:bool(j.get("cancel")))
                for original, marked in zip(outputs,labelled):
                    if original.get("extra",{}).get("draft_expires"):
                        db.run("""INSERT OR IGNORE INTO video_drafts
                            SELECT ?,job_id,provider_task,expires FROM video_drafts WHERE ref=?""",marked["ref"],original["ref"])
                outputs = labelled
            if j.get("cancel"):
                return
            j.update(outputs=outputs, state="done", phase="done", finished=time.time())
            record(j)
        except Exception as e:
            if not j.get("cancel"):
                j.update(state="error", error=f"{error_label}：{e}")
        log_end(j)


STATS_FILE = DATA / "stats.json"
try:
    STATS: dict = json.loads(STATS_FILE.read_text())
except Exception:
    STATS = {}


def job_class(p: dict):
    """-> (class key, units, default seconds per unit). Video time scales with its length (unit = 5 s of video)."""
    kind = p.get("kind") or "video"
    if kind == "image":
        if p.get("model") == "h3video":
            return f"image|h3video|{p.get('quality')}|{bool(p.get('turbo'))}", 1, (32 if p.get("turbo") else 110) * (2 if p.get("quality") == "hd" else 1)
        return f"image|h3img|{p.get('quality')}|{bool(p.get('expand'))}", 1, (50 if p.get("quality") == "16mp" else 30) + (25 if p.get("expand") else 0)
    ref, hd = bool(p.get("planned")), p.get("quality") == "hd"
    base = (150 if hd else 65) if ref else (120 if hd else 60)
    units = max(0.4, float(p.get("duration") or 5) / 5)
    return f"video|{'ref' if ref else 'fl2v'}|{p.get('quality')}|{bool(p.get('turbo'))}", units, base * (1 if p.get("turbo", True) else 4)


def estimate(cls: str, units: float, default: float) -> float:
    xs = sorted(STATS.get(cls) or [])
    per = xs[len(xs) // 2] if xs else default
    return round(per * units, 1)


def record(j: dict):
    m = j.get("meta") or {}
    if not m.get("cls") or not j.get("started") or not j.get("finished"):
        return
    took = j["finished"] - j["started"]
    if took <= 1:
        return
    xs = STATS.setdefault(m["cls"], [])
    xs.append(round(took / max(0.1, m.get("units") or 1), 1))
    del xs[:-12]
    try:
        STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATS_FILE.write_text(json.dumps(STATS))
    except Exception:
        pass


def remaining(j: dict) -> float:
    """Seconds until a job is done."""
    if j["state"] in ("done", "error"):
        return 0.0
    est = (j.get("meta") or {}).get("est") or 60
    if j["state"] == "queued":
        return est
    el = time.time() - j.get("started", time.time())
    rem = est - el
    if j.get("max") and (j.get("value") or 0) >= 2 and j.get("kind") != "render":   # sampling steps: project from their pace
        frac = j["value"] / j["max"]
        rem = min(rem, el * (1 - frac) / frac + 0.15 * est) if frac < 1 else min(rem, 0.15 * est)
    elif j.get("kind") == "render" and j.get("max"):
        frac = (j.get("value") or 0) / j["max"]
        if frac > 0.05:
            rem = el * (1 - frac) / frac
    return max(2.0, rem)


async def comfy_ws(app):
    """Follows ComfyUI's websocket for progress of our prompts; reconnects forever."""
    while True:
        try:
            async with app["http"].ws_connect(f"{COMFY.replace('http', 'ws', 1)}/ws?clientId={CLIENT_ID}", heartbeat=30) as ws:
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    m = json.loads(msg.data)
                    d = m.get("data") or {}
                    j = JOBS.get(d.get("prompt_id"))
                    if not j:
                        continue
                    t = m.get("type")
                    if t == "execution_start":
                        j["state"] = "running"; j["started"] = time.time()
                    elif t == "executing" and d.get("node"):
                        j["state"] = "running"; j["node"] = d["node"]; j.setdefault("started", time.time())
                    elif t == "progress":
                        j["state"] = "running"; j["value"], j["max"] = d.get("value"), d.get("max"); j["node"] = d.get("node")
                    elif t == "execution_error":
                        j["state"] = "error"; j["error"] = d.get("exception_message", "执行失败")[:500]; log_end(j)
                    elif t == "execution_interrupted":
                        j["state"] = "error"; j["error"] = "已取消"; log_end(j)
                    elif t in ("execution_success",) or (t == "executing" and d.get("node") is None):
                        await finish(app, d["prompt_id"])
        except Exception:
            pass
        await asyncio.sleep(2)


async def finish(app, pid):
    j = JOBS.get(pid)
    if not j or j["state"] in ("done", "error"):
        return
    async with app["http"].get(f"{COMFY}/history/{pid}") as r:
        h = await r.json()
    if pid not in h:
        return
    st = h[pid].get("status", {})
    if st.get("status_str") == "error":
        msgs = [m[1] for m in st.get("messages", []) if m[0] == "execution_error"]
        j["state"] = "error"; j["error"] = (msgs[0].get("exception_message") if msgs else "执行失败")[:500]
        log_end(j)
        return
    outs = []
    for o in h[pid].get("outputs", {}).values():
        for f in o.get("images", []) + o.get("videos", []) + o.get("gifs", []):
            ref = f"{f.get('type', 'output')}:{(f.get('subfolder') + '/') if f.get('subfolder') else ''}{f['filename']}"
            outs.append({"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "meta": f.get("metadata", {})})
    await complete_outputs(j, outs)


async def submit(app, graph, meta, kind):
    async with app["http"].post(f"{COMFY}/prompt", json={"prompt": graph, "client_id": CLIENT_ID}) as r:
        body = await r.json(content_type=None)
        if r.status != 200:
            err = body.get("error", {}).get("message", "") if isinstance(body, dict) else str(body)
            details = body.get("node_errors") if isinstance(body, dict) else None
            raise web.HTTPBadRequest(text=json.dumps({"error": f"ComfyUI 拒绝了任务: {err} {json.dumps(details, ensure_ascii=False)[:600]}"}, ensure_ascii=False),
                                     content_type="application/json")
    pid = body["prompt_id"]
    JOBS[pid] = {"id": pid, "kind": kind, "state": "queued", "created": time.time(), "meta": meta}
    db.task_start(id=pid, user_id=meta.get("uid"), board_id=meta.get("board"), label=meta.get("label"), capability=kind,
                  provider_id="local_h3", provider_kind="local_h3", model=meta.get("mode_name"), state="queued", cost=0)
    return pid


def log_end(j: dict):
    """Write a finished / failed job into the task log (once)."""
    if j.get("_logged") or j["state"] not in ("done", "error"):
        return
    j["_logged"] = True
    try:
        if j["state"] == "done" and (j.get("meta") or {}).get("uid") is not None:
            creative_memory.Store(sys.modules[__name__]).observe({"id": j["meta"]["uid"]}, {j["id"]: j})
        db.task_update(j["id"], state=j["state"], started=j.get("started"), finished=j.get("finished") or time.time(),
                       seconds=round((j.get("finished") or time.time()) - (j.get("started") or j["created"]), 1),
                       error=j.get("error"), outputs=[o.get("ref") for o in j.get("outputs") or []],
                       **generation_history_metadata(j))
    except Exception:
        pass


# ---------------------------------------------------------------- routes

routes = web.RouteTableDef()


@routes.get("/")
async def index(_):
    return web.FileResponse(ROOT / "static" / "index.html", headers={"Cache-Control": "no-cache"})


@routes.get("/login")
async def login_page(_):
    return web.FileResponse(ROOT / "static" / "login.html", headers={"Cache-Control": "no-cache"})


@routes.get("/console")
async def console_page(_):
    return web.FileResponse(ROOT / "static" / "console.html", headers={"Cache-Control": "no-cache"})


BOARDS = DATA / "boards"


def board_path(bid: str) -> Path:
    return board_store.board_path(BOARDS, bid)


def clean_board(v):
    board = board_store.clean_board(v, COMFY_DIR)
    if isinstance(board,dict) and isinstance(board.get("nodes"),list) and isinstance(board.get("edges"),list):
        board["edges"] = board_store.seed_audio_edges(board)
    return board


def write_board(path: Path, data: dict):
    if not path.is_file():
        data["created"] = time.time()
    creative_memory.remove_deleted_bindings(data)
    board_store.write_board(path, data)


def owned_project(user, project_id):
    if not isinstance(project_id, str) or not _ID.fullmatch(project_id):
        raise bad("项目编号无效")
    project = db.one("SELECT id,name FROM canvas_projects WHERE id=? AND owner=?", project_id, user["id"])
    if not project:
        raise bad("项目已不存在或无权管理")
    return project


def validate_canvas_destination(user, project_id, team_id):
    if project_id is not None and team_id is not None:
        raise bad("请在个人项目和团队空间中选择一个")
    if project_id is not None:
        owned_project(user,project_id)
    if team_id is not None:
        team_membership(team_id,user)


def project_name(payload):
    name = payload.get("name") if isinstance(payload, dict) else None
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or "\n" in name or "\r" in name:
        raise bad("请输入 1–60 字的项目名称")
    return name.strip()


def assign_canvas_project(board_id, project_id):
    if project_id is None:
        db.run("DELETE FROM canvas_project_boards WHERE board_id=?", board_id)
    else:
        db.run("""INSERT INTO canvas_project_boards(board_id,project_id) VALUES(?,?)
                  ON CONFLICT(board_id) DO UPDATE SET project_id=excluded.project_id""", board_id, project_id)


@routes.get("/api/canvas-projects")
async def list_canvas_projects(req):
    return web.json_response(db.q("SELECT id,name FROM canvas_projects WHERE owner=? ORDER BY created,id", req["user"]["id"]))


@routes.post("/api/boards/batch-project")
async def move_boards_to_project(req):
    payload = await req.json()
    boards = payload.get("boards") if isinstance(payload,dict) else None
    if (not isinstance(boards,list) or not 1<=len(boards)<=100 or
            any(not isinstance(bid,str) or not _ID.fullmatch(bid) for bid in boards)):
        raise bad("请选择 1–100 张画布")
    if ("project" in payload)==("name" in payload):
        raise bad("请选择现有项目，或填写新建项目的名称")
    user,ids = req["user"],list(dict.fromkeys(boards))
    for bid in ids:
        board = board_meta(board_path(bid))
        if not board or board.get("owner")!=user["id"] or board.get("team"):
            raise web.HTTPForbidden(text='{"error":"只能移动自己拥有的个人画布"}',content_type="application/json")
    with db.transaction():
        if "name" in payload:
            name = project_name(payload)
            project = {"id":"p"+uuid.uuid4().hex[:20],"name":name}
            db.run("INSERT INTO canvas_projects VALUES(?,?,?,?)",project["id"],user["id"],name,time.time())
        else:
            project = owned_project(user,payload["project"]) if payload["project"] is not None else None
        for bid in ids:
            assign_canvas_project(bid,project["id"] if project else None)
    return web.json_response({"project":project,"count":len(ids)})


@routes.post("/api/canvas-projects")
async def create_canvas_project(req):
    payload = await req.json()
    user = req["user"]
    name = project_name(payload)
    bid = payload.get("board")
    if bid is not None and board_meta(board_path(bid)).get("owner") != user["id"]:
        raise bad("只有画布所有者可以将画布移入项目")
    project_id = "p" + uuid.uuid4().hex[:20]
    db.run("INSERT INTO canvas_projects VALUES(?,?,?,?)", project_id, user["id"], name, time.time())
    if bid is not None:
        assign_canvas_project(bid, project_id)
    return web.json_response({"id":project_id, "name":name}, status=201)


@routes.patch("/api/canvas-projects/{pid}")
async def rename_canvas_project(req):
    payload = await req.json()
    project = owned_project(req["user"], req.match_info["pid"])
    name = project_name(payload)
    db.run("UPDATE canvas_projects SET name=? WHERE id=?", name, project["id"])
    return web.json_response({"id":project["id"], "name":name})


@routes.delete("/api/canvas-projects/{pid}")
async def dissolve_canvas_project(req):
    project = owned_project(req["user"], req.match_info["pid"])
    db.run("DELETE FROM canvas_projects WHERE id=?", project["id"])
    return web.json_response({"ok":True})


@routes.post("/api/board/{bid}/project")
async def move_canvas_project(req):
    payload = await req.json()
    if not isinstance(payload, dict) or "project" not in payload:
        raise bad("请选择目标项目")
    bid, user = req.match_info["bid"], req["user"]
    if board_meta(board_path(bid)).get("owner") != user["id"]:
        raise bad("只有画布所有者可以移动画布")
    project = payload["project"]
    if project is not None:
        owned_project(user, project)
    assign_canvas_project(bid, project)
    return web.json_response({"ok":True, "project":project})


@routes.get("/api/boards")
async def list_boards(req):
    u = req["user"]
    BOARDS.mkdir(parents=True, exist_ok=True)
    groups = {row["board_id"]:row["project_id"] for row in db.q(
        """SELECT b.board_id,b.project_id FROM canvas_project_boards b
           JOIN canvas_projects p ON p.id=b.project_id WHERE p.owner=?""", u["id"])}
    out = []
    for f in sorted(BOARDS.glob("*.json"), key=lambda f: -f.stat().st_mtime):
        b = board_meta(f)
        if not b or not can_see(u, b):
            continue
        team = b.get("team")
        if u["role"] == "admin" and req.query.get("all") != "1" and b.get("owner") not in (None, u["id"]) and not b.get("shared") and not (
                team and db.one("SELECT 1 FROM canvas_team_members WHERE team_id=? AND user_id=?",team,u["id"])):
            continue                       # admins see others' private boards only on request (console)
        v = next((n["versions"][n["cur"]] for n in reversed(b.get("nodes", [])) if n.get("type") == "video" and
                  n.get("versions") and type(n.get("cur")) is int and 0<=n["cur"]<len(n["versions"])), None)
        out.append({"id": f.stem, "name": b.get("name") or "未命名画布", "nodes": len(b.get("nodes", [])), "mtime": f.stat().st_mtime,
                    "created":b.get("created"),
                    "owner": b.get("owner"), "shared": bool(b.get("shared")), "wiz": (b.get("wiz") or {}).get("step"),
                    "project":groups.get(f.stem) if b.get("owner") == u["id"] else None, "access":access_role(u,b),"team":team,
                    "cover": (v or {}).get("cover_url") or (v or {}).get("url")})
    return web.json_response(out)


@routes.get("/api/boards_legacy")
async def list_boards_legacy(req):
    BOARDS.mkdir(parents=True, exist_ok=True)
    old = DATA / "board.json"
    if old.exists() and not any(BOARDS.iterdir()):
        b = json.loads(old.read_text()); b.setdefault("name", "我的画布"); write_board(BOARDS / "default.json", b)
    out = []
    for f in sorted(BOARDS.glob("*.json"), key=lambda f: -f.stat().st_mtime):
        try:
            b = json.loads(f.read_text())
        except ValueError:
            continue
        if not isinstance(b, dict) or not can_see(req["user"], b):
            continue
        out.append({"id": f.stem, "name": b.get("name") or "未命名画布", "nodes": len(b.get("nodes", [])), "mtime": f.stat().st_mtime})
    return web.json_response(out)


@routes.get("/api/board/{bid}")
async def get_board(req):
    f = board_path(req.match_info["bid"])
    b = board_meta(f)
    if b and not can_see(req["user"], b):
        raise bad("没有权限打开这个项目")
    creative_memory.remove_deleted_bindings(b)
    if b:
        b["access"] = access_role(req["user"], b)
        b.pop("collaborators", None)
    return web.json_response(b)


@routes.put("/api/board/{bid}")
async def put_board(req):
    f = board_path(req.match_info["bid"])
    raw = await req.json()
    if not isinstance(raw, dict):
        raise bad("画布数据须为对象")
    data = clean_board(raw)
    u = req["user"]
    old = board_meta(f) if f.exists() else {}
    project_id,team_id = req.query.get("project"),req.query.get("team")
    if project_id is not None or team_id is not None:
        if old:
            raise bad("已有画布请使用移动操作")
        validate_canvas_destination(u,project_id,team_id)
    if old and not can_edit(u, old):
        raise web.HTTPForbidden(text='{"error":"当前账号没有编辑权限"}', content_type="application/json")
    data.pop("access", None)
    data.pop("created",None)
    data.pop("collaborators", None)
    data.pop("team",None)
    if old.get("team") or team_id:
        data["team"] = old.get("team") or team_id
    if old.get("collaborators"):
        data["collaborators"] = old["collaborators"]
    if old.get("created"):
        data["created"] = old["created"]
    require_media(u, media_references(data) - media_references(old))
    data["owner"] = old.get("owner") or u["id"]          # the owner never changes through a save
    data["shared"] = bool(data.get("shared")) if (data["owner"] == u["id"] or u["role"] == "admin") else bool(old.get("shared"))
    if data.get("team"):
        data["shared"] = False
    # optimistic concurrency: a page may only overwrite the revision it loaded (another tab, an unload save of a stale
    # page, or a server-side edit would otherwise be silently lost)
    cur = old.get("rev")
    if cur is not None and data.get("rev") != cur:
        return web.json_response({"error": "画布已在别处更新", "stale": True, "rev": cur}, status=409)
    data["rev"] = int(cur or 0) + 1
    write_board(f, data)
    if project_id is not None:
        assign_canvas_project(f.stem, project_id)
    return web.json_response({"ok": True, "rev": data["rev"]})


@routes.get("/api/board/{bid}/workflow-review")
async def get_workflow_review(req):
    board = board_meta(board_path(req.match_info["bid"]))
    if not board or not can_see(req["user"], board):
        return auth.err(404, "画布不存在或没有访问权限")
    node_id = req.query.get("node")
    version = req.query.get("version")
    if version is not None and (not node_id or not re.fullmatch(r"[1-9][0-9]{0,4}", version)):
        raise bad("版本编号格式不正确")
    try:
        report = workflow_review.build(board, node_id, int(version) if version is not None else None)
    except ValueError as e:
        return auth.err(404, str(e))
    return web.json_response({**report, "markdown":workflow_review.markdown(report)})


@routes.delete("/api/board/{bid}")
async def delete_board(req):
    f = board_path(req.match_info["bid"])
    old = board_meta(f) if f.exists() else {}
    if old and not (req["user"]["role"] == "admin" or old.get("owner") in (None, req["user"]["id"])):
        raise bad("只有项目的主人可以删除")
    if f.exists():
        f.rename(f.with_suffix(".deleted"))
        db.run("DELETE FROM canvas_comments WHERE board_id=?", f.stem)
        db.run("DELETE FROM canvas_snapshots WHERE board_id=?", f.stem)
        db.run("DELETE FROM shared_canvas_items WHERE board_id=?",f.stem)
        delete_showcase_entries(f.stem)
    assign_canvas_project(f.stem, None)
    return web.json_response({"ok": True})


def share_details(board):
    members = board.get("collaborators") or {}
    accounts = []
    if members:
        keys = list(members)
        for row in db.q(f"SELECT id,username,name,disabled FROM users WHERE id IN ({','.join('?' for _ in keys)}) ORDER BY username", *keys):
            accounts.append({**row, "role":members[str(row["id"])]})
    return {"shared":bool(board.get("shared")), "collaborators":accounts, "rev":board.get("rev"),"team":board.get("team")}


def team_membership(team_id, user):
    if not isinstance(team_id,str) or not _ID.fullmatch(team_id):
        raise bad("团队编号无效")
    team = db.one("""SELECT t.* FROM canvas_teams t JOIN canvas_team_members m ON m.team_id=t.id
                     WHERE t.id=? AND m.user_id=?""", team_id,user["id"])
    if not team:
        raise web.HTTPNotFound()
    return team


@routes.get("/api/canvas-teams")
async def canvas_teams(req):
    user = req["user"]
    return web.json_response(db.q("""SELECT t.id,t.name,t.owner=? AS managed FROM canvas_teams t
                                    JOIN canvas_team_members m ON m.team_id=t.id
                                    WHERE m.user_id=? ORDER BY t.created,t.id""",user["id"],user["id"]))


@routes.post("/api/canvas-teams")
async def create_canvas_team(req):
    name = project_name(await req.json())
    owner = req["user"]["id"]
    team_id = "team"+uuid.uuid4().hex[:20]
    with db.transaction():
        db.run("INSERT INTO canvas_teams VALUES(?,?,?,?)",team_id,owner,name,time.time())
        db.run("INSERT INTO canvas_team_members VALUES(?,?)",team_id,owner)
    return web.json_response({"id":team_id,"name":name,"managed":True},status=201)


@routes.get("/api/canvas-teams/{tid}/members")
async def canvas_team_members(req):
    team = team_membership(req.match_info["tid"],req["user"])
    members = db.q("""SELECT u.username,u.name,u.id=t.owner AS manager,u.disabled FROM canvas_team_members m
                      JOIN users u ON u.id=m.user_id JOIN canvas_teams t ON t.id=m.team_id
                      WHERE t.id=? ORDER BY manager DESC,u.username""",team["id"])
    return web.json_response(members)


@routes.patch("/api/canvas-teams/{tid}/members")
async def update_canvas_team_members(req):
    team = team_membership(req.match_info["tid"],req["user"])
    if team["owner"] != req["user"]["id"]:
        raise web.HTTPForbidden()
    payload = await req.json()
    username = payload.get("username") if isinstance(payload,dict) else None
    action = payload.get("action") if isinstance(payload,dict) else None
    if not isinstance(username,str) or not username.strip() or action not in ("add","remove"):
        raise bad("请输入账号并选择成员操作")
    account = db.one("SELECT id,disabled FROM users WHERE username=?",username.strip())
    if not account or account["id"] == team["owner"] or (action=="add" and account["disabled"]):
        raise bad("账号不可用或属于团队创建者")
    if action == "add":
        db.run("INSERT OR IGNORE INTO canvas_team_members VALUES(?,?)",team["id"],account["id"])
    else:
        db.run("DELETE FROM canvas_team_members WHERE team_id=? AND user_id=?",team["id"],account["id"])
    return web.json_response({"ok":True})


def board_to_share(req):
    path = board_path(req.match_info["bid"])
    board = board_meta(path)
    user = req["user"]
    if not board or not can_see(user, board):
        raise web.HTTPNotFound()
    if access_role(user, board) != "owner":
        raise web.HTTPForbidden()
    return path, board


@routes.get("/api/board/{bid}/access")
async def get_board_access(req):
    _, board = board_to_share(req)
    return web.json_response(share_details(board))


@routes.patch("/api/board/{bid}/access")
async def update_board_access(req):
    payload = await req.json()
    path, board = board_to_share(req)
    if not isinstance(payload, dict):
        raise bad("分享权限格式无效")
    if "team" in payload:
        if board.get("owner") != req["user"]["id"]:
            raise web.HTTPForbidden()
        if payload["team"] is None:
            board.pop("team",None)
        else:
            board["team"] = team_membership(payload["team"],req["user"])["id"]
        board["shared"] = False
    elif "shared" in payload:
        if type(payload["shared"]) is not bool:
            raise bad("团队共享状态无效")
        if board.get("team") and payload["shared"]:
            raise bad("请先将画布移回个人空间")
        board["shared"] = payload["shared"]
    elif "username" in payload:
        username, role = payload["username"], payload.get("role")
        if not isinstance(username, str) or not username.strip() or role not in (None, "reviewer", "editor"):
            raise bad("请输入账号并选择协作权限")
        account = db.one("SELECT id,role,disabled FROM users WHERE username=?", username.strip())
        if not account:
            raise bad("账号不存在")
        key = str(account["id"])
        members = board.setdefault("collaborators", {})
        if role is None:
            members.pop(key, None)
        else:
            if account["role"] == "admin" or account["id"] == board.get("owner") or account["disabled"]:
                raise bad("此账号无需邀请或已停用")
            if key not in members and len(members) >= 100:
                raise bad("单张画布最多邀请 100 个账号")
            members[key] = role
    else:
        raise bad("请选择要修改的分享权限")
    board["rev"] = int(board.get("rev") or 0) + 1
    write_board(path, board)
    return web.json_response(share_details(board))


@routes.get("/api/board/{bid}/snapshot")
async def board_snapshot_status(req):
    path, _ = board_to_share(req)
    row = db.one("SELECT token,created FROM canvas_snapshots WHERE board_id=?", path.stem)
    return web.json_response(row, headers=public_canvas.HEADERS)


@routes.put("/api/board/{bid}/snapshot")
async def publish_board_snapshot(req):
    path, board = board_to_share(req)
    current = db.one("SELECT token,created FROM canvas_snapshots WHERE board_id=?", path.stem)
    if current:
        return web.json_response(current, headers=public_canvas.HEADERS)
    snapshot = public_canvas.capture(board, COMFY_DIR)
    token, created = secrets.token_urlsafe(32), time.time()
    db.run("INSERT INTO canvas_snapshots VALUES(?,?,?,?)", path.stem, token, json.dumps(snapshot, ensure_ascii=False), created)
    return web.json_response({"token":token,"created":created}, status=201, headers=public_canvas.HEADERS)


@routes.delete("/api/board/{bid}/snapshot")
async def revoke_board_snapshot(req):
    path, _ = board_to_share(req)
    db.run("DELETE FROM canvas_snapshots WHERE board_id=?", path.stem)
    return web.json_response({"ok":True}, headers=public_canvas.HEADERS)


def require_snapshot_board(row):
    if not row or not board_path(row["board_id"]).is_file():
        raise web.HTTPNotFound(headers=public_canvas.HEADERS)


def read_public_snapshot(token):
    row = public_snapshot_row(token)
    require_snapshot_board(row)
    return json.loads(row["data"]), row["created"]


def public_snapshot_row(token):
    return db.one("""SELECT board_id,data,created FROM canvas_snapshots WHERE token=?
                     UNION ALL SELECT board_id,snapshot,published FROM showcase_entries
                     WHERE token=? AND state='approved' AND snapshot IS NOT NULL""", token, token)


def snapshot_page_file():
    headers = {**public_canvas.HEADERS,
               "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"}
    return web.FileResponse(ROOT / "static" / "public-canvas.html", headers=headers)


@routes.get(r"/share/{token:[A-Za-z0-9_-]{43}}")
async def public_snapshot_page(req):
    require_snapshot_board(public_snapshot_row(req.match_info["token"]))
    return snapshot_page_file()


@routes.get(r"/api/share/{token:[A-Za-z0-9_-]{43}}")
async def public_snapshot_data(req):
    snapshot, created = read_public_snapshot(req.match_info["token"])
    snapshot.pop("media")
    return web.json_response({**snapshot,"created":created}, headers=public_canvas.HEADERS)


@routes.get(r"/api/share/{token:[A-Za-z0-9_-]{43}}/media/{index:\d{1,6}}")
async def public_snapshot_media(req):
    snapshot, _ = read_public_snapshot(req.match_info["token"])
    return snapshot_media_file(snapshot,int(req.match_info["index"]))


def snapshot_media_file(snapshot,index):
    refs = snapshot["media"]
    path = public_canvas.media_path(COMFY_DIR, refs[index]) if index < len(refs) else None
    if not path:
        raise web.HTTPNotFound(headers=public_canvas.HEADERS)
    return web.FileResponse(path, headers=public_canvas.HEADERS)


def ensure_snapshot_copy(token,snapshot,user):
    existing = db.one("SELECT board_id FROM canvas_snapshot_copies WHERE token=? AND user_id=?", token, user["id"])
    if existing:
        prior = board_meta(board_path(existing["board_id"]))
        if prior.get("owner") == user["id"]:
            return existing["board_id"], False
    bid = "b" + uuid.uuid4().hex[:20]
    grant_media(user,*snapshot["media"])
    write_board(board_path(bid), public_canvas.copy_board(snapshot,user["id"]))
    db.run("INSERT OR REPLACE INTO canvas_snapshot_copies VALUES(?,?,?)", token, user["id"], bid)
    return bid, True


@routes.post(r"/api/share/{token:[A-Za-z0-9_-]{43}}/copy")
@routes.post(r"/api/share/{token:[A-Za-z0-9_-]{43}}/explain")
async def copy_public_snapshot(req):
    if req.content_type != "application/json":
        raise bad("请求格式无效")
    token, user = req.match_info["token"], req["user"]
    snapshot, _ = read_public_snapshot(token)
    bid, created = ensure_snapshot_copy(token,snapshot,user)
    response = {"id":bid}
    if req.path.endswith("/explain"):
        try:
            response["session"] = req.app["agent_chat"].explain_snapshot(user,bid,public_canvas.explanation_context(snapshot))
        except agent_chat.ToolError as error:
            return auth.err(409,str(error))
    return web.json_response(response,status=201 if created else 200,headers=public_canvas.HEADERS)


SHOWCASE_FIELDS = """s.token,s.title,s.description,s.published,s.snapshot IS NOT NULL AS has_canvas,
                     CASE WHEN s.video_ref LIKE '%.gif' THEN 'gif' ELSE 'video' END AS media_kind,
                     COALESCE(NULLIF(u.name,''),'OneShot 创作者') AS author"""
SHOWCASE_PAGE_SIZE = 24
SHOWCASE_PROMPT_LIMIT = 5000


@routes.get("/showcase")
@routes.get(r"/showcase/{token:[A-Za-z0-9_-]{43}}")
@routes.get(r"/showcase/creator/{slug:[a-f0-9]{32}}")
async def showcase_page(req):
    headers = {**public_canvas.HEADERS,
               "Content-Security-Policy":"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"}
    return web.FileResponse(ROOT / "static" / "showcase.html", headers=headers)


def showcase_offset(req):
    page = req.query.get("page","1")
    if not re.fullmatch(r"[1-9][0-9]{0,3}",page):
        raise bad("页码无效")
    return (int(page)-1)*SHOWCASE_PAGE_SIZE


def showcase_public_items(req, creator=None):
    search = req.query.get("q","").strip()[:80]
    kind = req.query.get("kind","")
    if kind not in ("","video","gif"):
        raise bad("作品类型无效")
    filter_kind = {"":"", "video":"AND s.video_ref NOT LIKE '%.gif'", "gif":"AND s.video_ref LIKE '%.gif'"}[kind]
    filter_creator = "AND c.slug=?" if creator else ""
    args = [search,creator] if creator else [search]
    rows = db.q(f"""SELECT {SHOWCASE_FIELDS},c.slug AS creator FROM showcase_entries s
                    JOIN users u ON u.id=s.owner JOIN showcase_creators c ON c.owner=s.owner
                    WHERE s.state='approved' AND instr(lower(s.title||' '||s.description||' '||
                      COALESCE(u.name,'')),lower(?)) > 0 {filter_creator} {filter_kind}
                    ORDER BY s.published DESC,s.token LIMIT ? OFFSET ?""",
                *args,SHOWCASE_PAGE_SIZE+1,showcase_offset(req))
    return {"items":rows[:SHOWCASE_PAGE_SIZE],"more":len(rows)>SHOWCASE_PAGE_SIZE}


@routes.get("/api/showcase")
async def showcase_feed(req):
    return web.json_response(showcase_public_items(req), headers=public_canvas.HEADERS)


@routes.get(r"/api/showcase/creator/{slug:[a-f0-9]{32}}")
async def showcase_creator(req):
    slug = req.match_info["slug"]
    profile = db.one("""SELECT COALESCE(NULLIF(u.name,''),'OneShot 创作者') AS name
                       FROM showcase_creators c JOIN users u ON u.id=c.owner WHERE c.slug=?
                       AND EXISTS (SELECT 1 FROM showcase_entries s WHERE s.owner=c.owner AND s.state='approved')""",slug)
    if not profile:
        return auth.err(404,"创作者主页尚未公开")
    return web.json_response({**showcase_public_items(req,slug),"name":profile["name"]}, headers=public_canvas.HEADERS)


@routes.get("/api/showcase/me")
async def showcase_my_entries(req):
    uid = req["user"]["id"]
    rows = db.q("""SELECT token,board_id,title,description,state,reason FROM showcase_entries
                   WHERE owner=? ORDER BY submitted DESC,token LIMIT ? OFFSET ?""",
                uid,SHOWCASE_PAGE_SIZE+1,showcase_offset(req))
    creator = db.one("""SELECT slug FROM showcase_creators c WHERE owner=?
                       AND EXISTS (SELECT 1 FROM showcase_entries s WHERE s.owner=c.owner AND s.state='approved')""",uid)
    return web.json_response({"items":rows[:SHOWCASE_PAGE_SIZE],"more":len(rows)>SHOWCASE_PAGE_SIZE,
                              "creator":creator["slug"] if creator else None}, headers=public_canvas.HEADERS)


@routes.get(r"/api/showcase/{token:[A-Za-z0-9_-]{43}}")
async def showcase_detail(req):
    row = db.one(f"""SELECT {SHOWCASE_FIELDS},c.slug AS creator FROM showcase_entries s
                     JOIN users u ON u.id=s.owner JOIN showcase_creators c ON c.owner=s.owner
                     WHERE s.token=? AND s.state='approved'""", req.match_info["token"])
    if not row:
        raise web.HTTPNotFound(headers=public_canvas.HEADERS)
    template = db.one("""SELECT t.id,t.name FROM showcase_template_links l
                         JOIN showcase_entries s ON s.token=l.token AND s.state='approved'
                         JOIN canvas_templates t ON t.id=l.template_id AND t.owner=s.owner
                         JOIN canvas_template_publications p ON p.template_id=t.id WHERE l.token=?""",row["token"])
    if template:
        row["template"] = template
    if prompt := db.one("SELECT prompt FROM showcase_prompts WHERE token=?", row["token"]):
        row["prompt"] = prompt["prompt"]
    return web.json_response(row, headers=public_canvas.HEADERS)


@routes.post(r"/api/showcase/{token:[A-Za-z0-9_-]{43}}/use-prompt")
async def use_showcase_prompt(req):
    try:
        data = await req.json()
    except (ValueError, UnicodeError):
        raise bad("请求格式不正确") from None
    key = data.get("request_key") if isinstance(data,dict) else None
    if not isinstance(key,str) or not re.fullmatch(r"[\w-]{16,80}",key,re.ASCII):
        raise bad("创作草稿编号无效")
    uid, token = req["user"]["id"], req.match_info["token"]
    source = db.one("""SELECT s.title,p.prompt FROM showcase_entries s JOIN showcase_prompts p ON p.token=s.token
                       WHERE s.token=? AND s.state='approved'""",token)
    if not source:
        return auth.err(404,"此作品的提示词已撤回或尚未公开")
    digest = hashlib.sha256(f"showcase-prompt:{uid}:{token}:{key}".encode()).hexdigest()
    bid = "b" + digest[:20]
    path = board_path(bid)
    if path.is_file():
        if board_meta(path).get("owner") != uid:
            raise web.HTTPConflict()
        return web.json_response({"id":bid},headers=public_canvas.HEADERS)
    draft = {"name":("新作 · "+source["title"])[:80],"owner":uid,"rev":1,"seq":2,
             "nodes":[{"id":"n1","type":"video","name":"视频草稿","x":80,"y":90,
                       "versions":[],"cur":-1,"job":None,"data":{"prompt":source["prompt"],"pmode":"free"}}],
             "edges":[],"groups":[],"view":{"x":0,"y":0,"k":1}}
    write_board(path, draft)
    return web.json_response({"id":bid},status=201,headers=public_canvas.HEADERS)


def showcase_media(req, state):
    asset = req.match_info["asset"]
    cover = asset == "cover"
    column = "cover" if cover else "video_ref"
    row = db.one(f"SELECT {column} FROM showcase_entries WHERE token=? AND state=?",
                 req.match_info["token"], state)
    if row:
        if cover:
            return web.Response(body=row["cover"], content_type="image/jpeg", headers=public_canvas.HEADERS)
        ref = row["video_ref"]
        path = showcase.work_path(COMFY_DIR,ref) if ref.endswith(".gif") == (asset=="gif") else None
        if path:
            return web.FileResponse(path, headers=public_canvas.HEADERS)
    raise web.HTTPNotFound(headers=public_canvas.HEADERS)


@routes.get(r"/api/showcase/{token:[A-Za-z0-9_-]{43}}/{asset:cover|video|gif}")
async def showcase_public_media(req):
    return showcase_media(req,"approved")


@routes.get("/api/board/{bid}/showcase")
async def board_showcase(req):
    path, _ = board_to_share(req)
    rows = db.q("""SELECT s.token,s.title,s.state,s.reason,s.owner=? AS can_link_template,
                          EXISTS(SELECT 1 FROM showcase_prompts q WHERE q.token=s.token) AS has_prompt,
                          l.template_id,t.name AS template_name,p.published AS template_published
                   FROM showcase_entries s LEFT JOIN showcase_template_links l ON l.token=s.token
                   LEFT JOIN canvas_templates t ON t.id=l.template_id
                   LEFT JOIN canvas_template_publications p ON p.template_id=t.id
                   WHERE s.board_id=? ORDER BY s.submitted DESC,s.token""", req["user"]["id"],path.stem)
    return web.json_response(rows, headers=public_canvas.HEADERS)


@routes.post("/api/board/{bid}/showcase")
async def submit_showcase(req):
    path, board = board_to_share(req)
    if req.content_type != "multipart/form-data":
        return await store_showcase(req,path,board,await req.json(),{})
    folder = COMFY_DIR / "showcase"
    folder.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".upload-",dir=folder) as temporary:
        try:
            payload, files = await showcase.read_upload(req,Path(temporary),path.stem)
        except (ValueError,UnicodeError) as error:
            raise bad(str(error) if not isinstance(error,json.JSONDecodeError) else "作品信息格式不正确") from None
        except web.HTTPRequestEntityTooLarge:
            return auth.err(413,"成片最多 300 MB，封面最多 20 MB")
        return await store_showcase(req,path,board,payload,files)


async def store_showcase(req, path, board, payload, files):
    if not isinstance(payload,dict):
        raise bad("请填写作品信息")
    title, description = payload.get("title"), payload.get("description","")
    prompt = payload.get("public_prompt")
    attach = payload.get("attach_canvas",False)
    source, cover = payload.get("video"), payload.get("cover")
    video_file, cover_file = files.get("video"), files.get("cover")
    gif_ref = payload.get("gif_ref")
    if gif_ref is not None and (not isinstance(gif_ref,str) or not showcase.EXPORTED_GIF.fullmatch(gif_ref)):
        raise bad("请选择已生成的 GIF")
    if sum(value is not None for value in (video_file,source,gif_ref)) != 1 or cover_file and cover is not None:
        raise bad("请选择一个作品来源和一个封面来源")
    if (not isinstance(title,str) or not 1 <= len(title.strip()) <= 80
            or not isinstance(description,str) or len(description.strip()) > 500
            or type(attach) is not bool or payload.get("confirmed") is not True
            or not all(isinstance(asset,dict) and isinstance(asset.get("node"),str)
                       and isinstance(asset.get("ref"),str) for asset in (source,cover) if asset is not None)):
        raise bad("请确认发布，并填写有效的作品标题、简介与素材")
    if prompt is not None and (not isinstance(prompt,str) or not 1 <= len(prompt.strip()) <= SHOWCASE_PROMPT_LIMIT):
        raise bad("公开提示词应为 1–5000 字")
    if payload.get("revision") != board.get("rev"):
        return auth.err(409,"画布已更新，请重新选择要发布的版本")
    uid = req["user"]["id"]
    template = payload.get("template")
    validate_showcase_template(template,uid)
    event = None
    if "event" in payload:
        event = creative_events.find_event(creative_events.field(payload,"event",21,required=True))
        track = creative_events.field(payload,"track",60)
        creative_events.validate_submission(event,uid,track)
    try:
        index = showcase.find_version(board,"video",source["node"],source["ref"]) if source else None
        if cover is not None:
            showcase.find_version(board,"image",cover["node"],cover["ref"])
    except ValueError as error:
        raise bad(str(error)) from None
    node_id = ""
    if video_file:
        video_path, video_ref = video_file
    elif gif_ref:
        video_ref = gif_ref
        video_path = showcase.work_path(COMFY_DIR,gif_ref)
    else:
        video_ref, node_id = source["ref"],source["node"]
        video_path = public_canvas.media_path(COMFY_DIR,video_ref,"video")
    cover_path = cover_file[0] if cover_file else public_canvas.media_path(COMFY_DIR,cover["ref"],"image") if cover else None
    if not video_path or video_path.stat().st_size > showcase.VIDEO_LIMIT or cover and not cover_path:
        raise bad("请使用可读取的作品文件（最多 300 MB）和封面")
    snapshot = showcase.capture(board,COMFY_DIR,node_id,index) if attach else None
    refs = set(snapshot["media"]) if snapshot else set()
    if not video_file:
        refs.add(video_ref)
    if cover:
        refs.add(cover["ref"])
    require_media(req["user"],refs)
    if event:
        if video_ref.endswith(".gif"):
            raise bad("创作活动投稿需要视频作品")
        await creative_events.validate_video(event,video_path)
    try:
        jpg = await asyncio.to_thread(showcase.cover_jpeg,video_path,cover_path,check_video=bool(video_file))
    except (OSError,ValueError,IndexError,DecompressionBombError) as error:
        raise bad("无法读取作品或封面，请检查文件格式") from error
    _, current = board_to_share(req)
    if current.get("rev") != board.get("rev"):
        return auth.err(409,"画布已更新，请重新选择要发布的版本")
    destination = showcase.upload_path(COMFY_DIR,video_ref) if video_file else None
    if destination and not destination.exists():
        os.replace(video_path,destination)
    try:
        with db.transaction():
            validate_showcase_template(template,uid)
            row = insert_showcase(path.stem,uid,node_id,video_ref,title.strip(),description.strip(),jpg,snapshot,template,
                                  prompt=prompt.strip() if prompt else None)
            if event:
                row["event_entry"], _ = creative_events.store_entry(event,uid,row["token"],track)
    except Exception:
        discard_showcase_video(video_ref)
        raise
    return web.json_response(row, status=201, headers=public_canvas.HEADERS)


def insert_showcase(bid,uid,node_id,video_ref,title,description,jpg,snapshot,template=None,*,prompt=None):
    token = secrets.token_urlsafe(32)
    changed = db.one("""INSERT INTO showcase_entries
              (token,board_id,owner,node_id,video_ref,cover,title,description,state,submitted,snapshot)
              VALUES(?,?,?,?,?,?,?,?,'pending',?,?)
              ON CONFLICT(board_id,node_id,video_ref) DO UPDATE SET cover=excluded.cover,title=excluded.title,
                description=excluded.description,state='pending',reason='',submitted=excluded.submitted,
                snapshot=excluded.snapshot WHERE showcase_entries.state='rejected'
              RETURNING token,title,state,reason""",
           token,bid,uid,node_id,video_ref,jpg,title,description,time.time(),
           json.dumps(snapshot,ensure_ascii=False) if snapshot else None)
    if changed:
        set_showcase_template(changed["token"],template)
        if prompt:
            db.run("""INSERT INTO showcase_prompts VALUES(?,?) ON CONFLICT(token)
                      DO UPDATE SET prompt=excluded.prompt""", changed["token"],prompt)
        else:
            db.run("DELETE FROM showcase_prompts WHERE token=?",changed["token"])
        return changed
    return db.one("SELECT token,title,state,reason FROM showcase_entries WHERE board_id=? AND node_id=? AND video_ref=?",
                  bid,node_id,video_ref)


def set_showcase_template(token, template):
    if template:
        db.run("""INSERT INTO showcase_template_links VALUES(?,?) ON CONFLICT(token)
                  DO UPDATE SET template_id=excluded.template_id""",token,template)
    else:
        db.run("DELETE FROM showcase_template_links WHERE token=?",token)


def discard_showcase_video(ref):
    if (path := showcase.upload_path(COMFY_DIR,ref)) and not db.one("SELECT 1 FROM showcase_entries WHERE video_ref=?",ref):
        path.unlink(missing_ok=True)


def delete_showcase_entries(bid, token=None):
    clause, args = ("board_id=? AND token=?", (bid,token)) if token else ("board_id=?", (bid,))
    rows = db.q(f"SELECT video_ref FROM showcase_entries WHERE {clause}",*args)
    db.run(f"DELETE FROM showcase_entries WHERE {clause}",*args)
    for row in rows:
        discard_showcase_video(row["video_ref"])


@routes.delete(r"/api/board/{bid}/showcase/{token:[A-Za-z0-9_-]{43}}")
async def withdraw_showcase(req):
    path, _ = board_to_share(req)
    delete_showcase_entries(path.stem,req.match_info["token"])
    return web.json_response({"ok":True}, headers=public_canvas.HEADERS)


def validate_showcase_template(template, uid):
    if template is None:
        return
    if not isinstance(template,str) or not re.fullmatch(r"t[a-f0-9]{20}",template):
        raise bad("工作流模板编号无效")
    if not db.one("""SELECT 1 FROM canvas_templates t JOIN canvas_template_publications p ON p.template_id=t.id
                     WHERE t.id=? AND t.owner=?""",template,uid):
        raise bad("请选择自己已共享的工作流模板")


@routes.put(r"/api/board/{bid}/showcase/{token:[A-Za-z0-9_-]{43}}/template")
async def update_showcase_template(req):
    path, _ = board_to_share(req)
    uid, token = req["user"]["id"],req.match_info["token"]
    payload = await req.json()
    if not isinstance(payload,dict) or "template" not in payload:
        raise bad("请选择要关联的工作流模板")
    template = payload["template"]
    with db.transaction():
        if not db.one("SELECT 1 FROM showcase_entries WHERE board_id=? AND token=? AND owner=? AND state='approved'",
                      path.stem,token,uid):
            raise web.HTTPNotFound()
        validate_showcase_template(template,uid)
        set_showcase_template(token,template)
    return web.json_response({"ok":True},headers=public_canvas.HEADERS)


@routes.delete(r"/api/board/{bid}/showcase/{token:[A-Za-z0-9_-]{43}}/prompt")
async def revoke_showcase_prompt(req):
    path, _ = board_to_share(req)
    token = req.match_info["token"]
    db.run("""DELETE FROM showcase_prompts WHERE token=? AND EXISTS (
              SELECT 1 FROM showcase_entries s WHERE s.token=? AND s.board_id=? AND s.owner=?)""",
           token,token,path.stem,req["user"]["id"])
    return web.json_response({"ok":True},headers=public_canvas.HEADERS)


def require_showcase_admin(req):
    if req["user"]["role"] != "admin":
        raise web.HTTPForbidden()


@routes.get("/api/admin/showcase")
async def showcase_pending(req):
    require_showcase_admin(req)
    rows = db.q(f"""SELECT {SHOWCASE_FIELDS},q.prompt FROM showcase_entries s JOIN users u ON u.id=s.owner
                    LEFT JOIN showcase_prompts q ON q.token=s.token
                    WHERE s.state='pending' ORDER BY s.submitted,s.token LIMIT 50""")
    return web.json_response(rows, headers=public_canvas.HEADERS)


@routes.get(r"/api/admin/showcase/{token:[A-Za-z0-9_-]{43}}/{asset:cover|video|gif}")
async def showcase_pending_media(req):
    require_showcase_admin(req)
    return showcase_media(req,"pending")


def pending_showcase_snapshot(req):
    require_showcase_admin(req)
    row = db.one("""SELECT board_id,snapshot,submitted FROM showcase_entries
                 WHERE token=? AND state='pending' AND snapshot IS NOT NULL""", req.match_info["token"])
    require_snapshot_board(row)
    return json.loads(row["snapshot"]), row["submitted"]


@routes.get(r"/showcase-review/{token:[A-Za-z0-9_-]{43}}")
async def showcase_review_page(req):
    pending_showcase_snapshot(req)
    return snapshot_page_file()


@routes.get(r"/api/admin/showcase/{token:[A-Za-z0-9_-]{43}}/canvas")
async def showcase_review_snapshot(req):
    snapshot, created = pending_showcase_snapshot(req)
    snapshot.pop("media")
    return web.json_response({**snapshot,"created":created}, headers=public_canvas.HEADERS)


@routes.get(r"/api/admin/showcase/{token:[A-Za-z0-9_-]{43}}/canvas/media/{index:\d{1,6}}")
async def showcase_review_snapshot_media(req):
    snapshot, _ = pending_showcase_snapshot(req)
    return snapshot_media_file(snapshot,int(req.match_info["index"]))


@routes.patch(r"/api/admin/showcase/{token:[A-Za-z0-9_-]{43}}")
async def review_showcase(req):
    require_showcase_admin(req)
    payload = await req.json()
    state = payload.get("state") if isinstance(payload,dict) else None
    reason = payload.get("reason","") if isinstance(payload,dict) else ""
    if state not in ("approved","rejected") or not isinstance(reason,str) or len(reason.strip()) > 500 or (
            state == "rejected" and not reason.strip()):
        raise bad("请选择审核结果，退回时请填写原因")
    with db.transaction():
        token = req.match_info["token"]
        entry = db.one("SELECT owner FROM showcase_entries WHERE token=? AND state='pending'",token)
        if not entry:
            return auth.err(409,"作品已处理或已撤回")
        if state == "approved":
            db.run("INSERT OR IGNORE INTO showcase_creators VALUES(?,?)",entry["owner"],uuid.uuid4().hex)
        db.run("UPDATE showcase_entries SET state=?,reason=?,published=? WHERE token=?",
               state,reason.strip() if state=="rejected" else "",time.time() if state=="approved" else None,token)
        if state == "rejected":
            db.run("UPDATE event_entries SET state='rejected',reason=? WHERE token=? AND state='pending'",reason.strip(),token)
    return web.json_response({"ok":True}, headers=public_canvas.HEADERS)


def comment_board(req):
    bid = req.match_info["bid"]
    board = board_meta(board_path(bid))
    if not board or not can_see(req["user"], board):
        raise web.HTTPNotFound()
    return bid, board


def owned_template(req):
    row = db.one("SELECT * FROM canvas_templates WHERE id=? AND owner=?", req.match_info["tid"], req["user"]["id"])
    if not row:
        raise web.HTTPNotFound()
    return row


def workflow_template_by_id(uid, tid):
    if preset := workflow_presets.PRESETS.get(tid):
        return preset
    row = db.one("""SELECT t.* FROM canvas_templates t
                    LEFT JOIN canvas_template_publications p ON p.template_id=t.id
                    WHERE t.id=? AND (t.owner=? OR p.template_id IS NOT NULL)""",
                 tid, uid)
    if row is None:
        return None
    board = json.loads(row["data"])
    row.update(data=board,description=board.pop("template_description",""))
    return row


def readable_template(req):
    row = workflow_template_by_id(req["user"]["id"],req.match_info["tid"])
    if row is None:
        raise web.HTTPNotFound()
    return row


def private_template_summaries(uid):
    return db.q("""SELECT t.id,t.name,t.updated,p.published,json_array_length(t.data,'$.nodes') AS nodes,
                          json_extract(t.data,'$.template_description') AS description,f.template_id IS NOT NULL AS favorite
                   FROM canvas_templates t LEFT JOIN canvas_template_publications p ON p.template_id=t.id
                   LEFT JOIN canvas_template_favorites f ON f.template_id=t.id AND f.owner=t.owner
                   WHERE t.owner=? ORDER BY t.updated DESC,t.id""", uid)


def shared_template_summaries(uid):
    return db.q("""SELECT t.id,t.name,p.published,json_array_length(t.data,'$.nodes') AS nodes,
                          t.owner=? AS owned, COALESCE(NULLIF(u.name,''),u.username) AS author,
                          json_extract(t.data,'$.template_description') AS description,f.template_id IS NOT NULL AS favorite
                   FROM canvas_template_publications p JOIN canvas_templates t ON t.id=p.template_id
                   JOIN users u ON u.id=t.owner
                   LEFT JOIN canvas_template_favorites f ON f.template_id=t.id AND f.owner=?
                   ORDER BY p.published DESC,t.id""", uid, uid)


def preset_template_summaries(uid):
    favorites = {row["template_id"] for row in db.q("SELECT template_id FROM canvas_template_favorites WHERE owner=?",uid)}
    return [{k:v for k,v in row.items() if k!="data"} | {"favorite":row["id"] in favorites}
            for row in workflow_presets.PRESETS.values()]


def favorite_template_summaries(uid):
    saved = db.q("""SELECT f.template_id,t.id,t.name,t.updated,p.published,t.owner=? AS owned,
                           json_array_length(t.data,'$.nodes') AS nodes,COALESCE(NULLIF(u.name,''),u.username) AS author,
                           json_extract(t.data,'$.template_description') AS description
                    FROM canvas_template_favorites f LEFT JOIN canvas_templates t ON t.id=f.template_id
                    LEFT JOIN canvas_template_publications p ON p.template_id=t.id LEFT JOIN users u ON u.id=t.owner
                    WHERE f.owner=? AND (t.id IS NULL OR t.owner=? OR p.template_id IS NOT NULL)
                    ORDER BY f.added DESC,f.template_id""", uid, uid, uid)
    rows = []
    for row in saved:
        tid = row.pop("template_id")
        if preset := workflow_presets.PRESETS.get(tid):
            row = {k:v for k,v in preset.items() if k!="data"}
        if row["id"]:
            rows.append(row | {"favorite":True})
    return rows


TEMPLATE_SUMMARIES = {"private":private_template_summaries,"catalog":shared_template_summaries,
                      "presets":preset_template_summaries,"favorites":favorite_template_summaries}


@routes.get("/api/canvas-templates")
@routes.get(r"/api/canvas-templates/{scope:catalog|presets|favorites}")
async def list_templates(req):
    return web.json_response(TEMPLATE_SUMMARIES[req.match_info.get("scope","private")](req["user"]["id"]))


def search_workflow_templates(user, scope, terms):
    scopes = ("private","catalog","presets") if scope=="all" else (scope,)
    tokens = set(term.casefold().strip() for term in terms if term.strip())
    matches = {}
    for source in scopes:
        for row in TEMPLATE_SUMMARIES[source](user["id"]):
            if row["id"] in matches:
                continue
            title = row["name"].casefold()
            details = " ".join(str(row.get(key) or "") for key in ("description","category","author")).casefold()
            score = sum(3 if token in title else 1 if token in details else 0 for token in tokens)
            if score or not tokens:
                matches[row["id"]] = (score,{**row,"scope":source})
    return [row for _,row in sorted(matches.values(),key=lambda item:(item[0],bool(item[1]["favorite"])),reverse=True)[:10]]


@routes.put("/api/canvas-templates/{tid}/favorite")
async def favorite_template(req):
    with db.transaction():
        template = readable_template(req)
        db.run("INSERT OR IGNORE INTO canvas_template_favorites VALUES(?,?,?)",req["user"]["id"],template["id"],time.time())
    return web.json_response({"favorite":True})


@routes.delete("/api/canvas-templates/{tid}/favorite")
async def unfavorite_template(req):
    db.run("DELETE FROM canvas_template_favorites WHERE owner=? AND template_id=?",req["user"]["id"],req.match_info["tid"])
    return web.json_response({"favorite":False})


def template_description(payload):
    description = payload.get("description","")
    if not isinstance(description,str) or len(description.strip()) > 300:
        raise bad("模板说明最多 300 字")
    return description.strip()


def template_from_board(user, payload):
    board = board_meta(board_path(payload.get("board")))
    if not board or not can_see(user,board):
        raise web.HTTPNotFound()
    if access_role(user,board) != "owner":
        raise web.HTTPForbidden()
    if not board.get("nodes"):
        raise bad("画布上至少需要一个节点")
    if "revision" in payload and payload["revision"] != board.get("rev"):
        raise web.HTTPConflict(text='{"error":"画布已更新，请打开最新版本后再保存模板"}',content_type="application/json")
    selected = payload.get("selected")
    if selected is not None:
        ids = {n["id"] for n in board["nodes"]}
        if not isinstance(selected,list) or not selected or any(not isinstance(nid,str) or nid not in ids for nid in selected):
            raise bad("选中的模板节点不存在")
    include_upstream = payload.get("include_upstream",False)
    if type(include_upstream) is not bool:
        raise bad("模板依赖选项无效")
    template = board_store.workflow_template(board, selected, include_upstream=include_upstream)
    template["template_description"] = template_description(payload)
    refs = media_references(template)
    require_media(user,refs)
    return template, refs


@routes.post("/api/canvas-templates")
async def save_template(req):
    payload = await req.json()
    user, name = req["user"], project_name(payload)
    template, refs = template_from_board(user,payload)
    tid, now = "t"+uuid.uuid4().hex[:20], time.time()
    with db.transaction():
        grant_media(user,*refs)
        db.run("INSERT INTO canvas_templates VALUES(?,?,?,?,?)",tid,user["id"],name,json.dumps(template,ensure_ascii=False),now)
    return web.json_response({"id":tid,"name":name,"nodes":len(template["nodes"]),"updated":now,
                              "description":template["template_description"]},status=201)


@routes.patch("/api/canvas-templates/{tid}")
async def rename_template(req):
    payload = await req.json()
    name = project_name(payload)
    row = owned_template(req)
    data = row["data"]
    if "description" in payload:
        data = json.dumps({**json.loads(data),"template_description":template_description(payload)},ensure_ascii=False)
    db.run("UPDATE canvas_templates SET name=?,data=?,updated=? WHERE id=?",name,data,time.time(),row["id"])
    return web.json_response({"ok":True})


def template_update_target(req, payload):
    if not isinstance(payload,dict):
        raise bad("模板更新参数无效")
    row = owned_template(req)
    if payload.get("template_updated")!=row["updated"]:
        raise web.HTTPConflict(text='{"error":"模板已更新，请刷新模板列表后重试"}',content_type="application/json")
    if db.one("SELECT 1 FROM canvas_template_publications WHERE template_id=?",row["id"]) and payload.get("confirmed_shared") is not True:
        raise bad("请确认现有共享链接将使用新模板内容")
    return row


def update_template_content(row, name, data):
    if row["name"]==name and row["data"]==data:
        return
    tid = row["id"]
    db.run("INSERT INTO canvas_template_history(template_id,name,data,updated) VALUES(?,?,?,?)",
           tid,row["name"],row["data"],row["updated"])
    db.run("UPDATE canvas_templates SET name=?,data=?,updated=? WHERE id=?",name,data,time.time(),tid)
    db.run("""DELETE FROM canvas_template_history WHERE id IN (
              SELECT id FROM canvas_template_history WHERE template_id=? ORDER BY id DESC LIMIT -1 OFFSET 20)""",tid)


@routes.put("/api/canvas-templates/{tid}/content")
async def replace_template_content(req):
    payload = await req.json()
    user, name = req["user"],project_name(payload)
    with db.transaction():
        row = template_update_target(req,payload)
        if "revision" not in payload:
            raise bad("缺少来源画布版本")
        template, refs = template_from_board(user,payload)
        grant_media(user,*refs)
        update_template_content(row,name,json.dumps(template,ensure_ascii=False))
    return web.json_response({"ok":True})


@routes.get("/api/canvas-templates/{tid}/history")
async def list_template_history(req):
    row = owned_template(req)
    return web.json_response(db.q("""SELECT id,name,updated,json_array_length(data,'$.nodes') AS nodes
                                     FROM canvas_template_history WHERE template_id=? ORDER BY id DESC""",row["id"]))


def template_history_version(req, row):
    version = db.one("SELECT * FROM canvas_template_history WHERE id=? AND template_id=?",req.match_info["version"],row["id"])
    if version is None:
        raise web.HTTPNotFound()
    return version


@routes.get(r"/api/canvas-templates/{tid}/history/{version:\d{1,16}}")
async def read_template_history(req):
    version = template_history_version(req,owned_template(req))
    data = json.loads(version["data"])
    return web.json_response({"nodes":[{"name":n["name"],"type":n["type"],"inputs":template_node_inputs(n)} for n in data["nodes"]],
                              "description":data.get("template_description","")})


@routes.post(r"/api/canvas-templates/{tid}/history/{version:\d{1,16}}/restore")
async def restore_template_history(req):
    payload = await req.json()
    with db.transaction():
        row = template_update_target(req,payload)
        version = template_history_version(req,row)
        require_media(req["user"],media_references(json.loads(version["data"])))
        update_template_content(row,version["name"],version["data"])
    return web.json_response({"ok":True})


@routes.delete("/api/canvas-templates/{tid}")
async def delete_template(req):
    row = owned_template(req)
    db.run("DELETE FROM canvas_templates WHERE id=?",row["id"])
    return web.json_response({"ok":True})


@routes.put("/api/canvas-templates/{tid}/publication")
async def publish_template(req):
    payload = await req.json()
    if not isinstance(payload,dict) or payload.get("confirmed") is not True:
        raise bad("请确认向所有登录用户共享模板")
    row = owned_template(req)
    require_media(req["user"], media_references(json.loads(row["data"])))
    db.run("INSERT OR IGNORE INTO canvas_template_publications VALUES(?,?)", row["id"], time.time())
    return web.json_response({"ok":True})


@routes.delete("/api/canvas-templates/{tid}/publication")
async def unpublish_template(req):
    row = owned_template(req)
    db.run("DELETE FROM canvas_template_publications WHERE template_id=?", row["id"])
    return web.json_response({"ok":True})


TEMPLATE_VIDEO_INPUTS = ("style","scene","people","camera","action","dialogue","sound","music")
TEMPLATE_SCRIPT_SETTINGS = {
    "nshots": ("auto","3","4","6","8"),
    "shotlen": ("auto","3","5","8"),
    "aspect": ("16:9","9:16","4:3","1:1","21:9"),
}


def template_node_inputs(node):
    data = node.get("data",{})
    if not isinstance(data,dict):
        return {}
    if node["type"] == "text":
        return {"text":str(data.get("text") or "")}
    if node["type"] == "video" and data.get("pmode") == "fields":
        fields = data.get("fields")
        fields = fields if isinstance(fields,dict) else {}
        return {f"fields.{key}":str(fields.get(key) or "") for key in TEMPLATE_VIDEO_INPUTS}
    if node["type"] == "script":
        settings = {key:str(data.get(key) or ("16:9" if key == "aspect" else "auto")) for key in TEMPLATE_SCRIPT_SETTINGS}
        return {"prompt":str(data.get("prompt") or ""),**settings}
    if node["type"] in ("image","video","audio","script"):
        return {"prompt":str(data.get("prompt") or "")}
    return {}


def template_copy_inputs(row, payload):
    if not isinstance(payload,dict):
        raise bad("模板填写内容无效")
    edits = payload.get("inputs",[])
    if not isinstance(edits,list) or len(edits)>200:
        raise bad("一次最多填写 200 项模板内容")
    if not edits:
        return row["data"]
    board = copy.deepcopy(row["data"])
    nodes = {n["id"]:n for n in board["nodes"]}
    applied = set()
    for edit in edits:
        if not isinstance(edit,dict) or any(not isinstance(edit.get(k),str) for k in ("node","field","before","value")):
            raise bad("模板填写内容无效")
        nid, field, old, value = (edit[k] for k in ("node","field","before","value"))
        node = nodes.get(nid)
        fields = template_node_inputs(node) if node else {}
        if field not in fields or (nid,field) in applied or len(value)>20_000 or len(old)>20_000:
            raise bad("模板填写项不存在、重复或超过 20000 字")
        if node["type"] == "script" and field in TEMPLATE_SCRIPT_SETTINGS and value not in TEMPLATE_SCRIPT_SETTINGS[field]:
            raise bad("分镜模板参数无效")
        if fields[field]!=old:
            raise web.HTTPConflict(text=json.dumps({"error":"模板内容已更新，请重新打开预览"},ensure_ascii=False),
                                   content_type="application/json")
        applied.add((nid,field))
        data = node.setdefault("data",{})
        if field.startswith("fields."):
            if not isinstance(data.get("fields"),dict):
                data["fields"] = {}
            data["fields"][field.split(".",1)[1]] = value
        else:
            data[field] = value
    return board


def capture_template_preview(row):
    template = row["data"]
    preview = public_canvas.capture({**template, "name":row["name"]}, COMFY_DIR)
    media = {ref:index for index,ref in enumerate(preview["media"])}
    preview["description"] = row["description"]
    node_ids = {node["id"] for node in preview["nodes"]}
    nodes = {item["id"]:item for item in template["nodes"]}
    edges = []
    for edge in board_store.seed_audio_edges(template):
        source_id, target_id = edge.get("from"), edge.get("to")
        if source_id not in node_ids or target_id not in node_ids:
            continue
        summary = {key:public_canvas.string(edge[key],80) for key in ("from","to","role","relation") if key in edge}
        source = nodes[source_id]
        ref = edge.get("source_ref") if edge.get("relation") in public_canvas.SOURCE_RELATIONS else edge.get("ref")
        if isinstance(ref,str) and ref and source["type"] in ("image","audio","video"):
            versions = source.get("versions") or []
            number = next((i for i,v in enumerate(versions,1) if isinstance(v,dict) and v.get("ref")==ref),None)
            if number and public_canvas.media_path(COMFY_DIR,ref,source["type"]):
                summary.update(version=number,media=media.setdefault(ref,len(media)))
            else:
                summary["reference_unavailable"] = True
        for key in ("start","end","time","at"):
            if (value := public_canvas.number(edge.get(key),None,0,86_400)) is not None:
                summary[key] = value
        for key in ("slot","prompt_slot"):
            if type(edge.get(key)) is int and 0 < edge[key] <= 5000:
                summary[key] = edge[key]
        edges.append(summary)
    preview["edges"] = edges
    preview["media"] = list(media)
    for node in preview["nodes"]:
        original = nodes[node["id"]]
        data = original.get("data")
        if isinstance(data,dict) and isinstance(data.get("prompt"),str):
            node["prompt"] = data["prompt"][:20_000]
    return preview


@routes.get("/api/canvas-templates/{tid}/preview")
async def preview_template(req):
    row = readable_template(req)
    preview = capture_template_preview(row)
    inputs = {node["id"]:template_node_inputs(node) for node in row["data"]["nodes"]}
    for node in preview["nodes"]:
        node["inputs"] = inputs[node["id"]]
    preview.pop("media")
    return web.json_response(preview, headers=public_canvas.HEADERS)


@routes.get(r"/api/canvas-templates/{tid}/preview/media/{index:\d{1,6}}")
async def preview_template_media(req):
    preview = capture_template_preview(readable_template(req))
    index = int(req.match_info["index"])
    if index >= len(preview["media"]):
        raise web.HTTPNotFound()
    path = public_canvas.media_path(COMFY_DIR, preview["media"][index])
    if not path:
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers=public_canvas.HEADERS)


@routes.post("/api/canvas-templates/{tid}/fragment")
async def template_fragment(req):
    row = readable_template(req)
    try:
        payload = await req.json() if req.can_read_body else {}
    except ValueError:
        raise bad("模板填写内容无效") from None
    board = template_copy_inputs(row,payload)
    grant_media(req["user"],*media_references(board))
    groups = board["groups"]
    if not groups and len(board["nodes"]) > 1:
        groups = [{"id":"template","name":row["name"],"nodes":[node["id"] for node in board["nodes"]]}]
    return web.json_response({"nodes":board["nodes"],"edges":board["edges"],"groups":groups})


@routes.post("/api/canvas-templates/{tid}/open")
async def open_template(req):
    payload = await req.json()
    row = readable_template(req)
    key = payload.get("request_key") if isinstance(payload,dict) else None
    if not isinstance(key,str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}",key):
        raise bad("模板请求编号无效")
    user, project = req["user"], payload.get("project")
    if project is not None:
        owned_project(user,project)
    bid = "b"+uuid.uuid5(uuid.NAMESPACE_URL, f"oneshot:template:{row['id']}:{user['id']}:{key}").hex[:24]
    path = board_path(bid)
    current = board_meta(path)
    if current:
        if current.get("owner") != user["id"]:
            raise web.HTTPConflict()
        return web.json_response({"id":bid})
    board = {**template_copy_inputs(row,payload),"name":row["name"],"owner":user["id"],"shared":False,"rev":1}
    grant_media(user,*media_references(board))
    write_board(path,board)
    if project:
        assign_canvas_project(bid,project)
    return web.json_response({"id":bid},status=201)


def comment_thread(bid, thread_id):
    row = db.one("SELECT * FROM canvas_comments WHERE board_id=? AND id=? AND thread_id IS NULL", bid, thread_id)
    if row is None:
        raise web.HTTPNotFound()
    return row


def comment_anchor(board, anchor):
    if anchor is None:
        return None
    if not isinstance(anchor, dict):
        raise bad("评论位置无效")
    if "node" in anchor:
        target = next((n for n in board.get("nodes", []) if n["id"] == anchor["node"]), None)
        if target is None:
            raise bad("评论对应的节点已不存在")
        ref = anchor.get("ref")
        version = next((v for v in target.get("versions", []) if ref and v.get("ref") == ref), None)
        if ref is not None and version is None:
            raise bad("评论对应的素材版本已不存在")
        result = {"node":target["id"], "name":target.get("name"), "ref":ref}
        if "passage" in anchor:
            text = (target.get("data") or {}).get("text")
            if target.get("type") != "text" or not isinstance(text,str) or ref is not None:
                raise bad("段落批注只能标注文本节点的正文")
            try:
                result["passage"] = document_review.capture(text,anchor["passage"])
            except ValueError as error:
                raise bad(str(error)) from error
        if "box" in anchor:
            box = anchor["box"]
            if not version or target.get("type") != "image" or not isinstance(box,list) or len(box) != 4 or any(
                    type(point) not in (int,float) or not 0 <= point <= 1 for point in box):
                raise bad("批注区域必须是对应图片版本上的有效矩形")
            box = [round(point,6) for point in box]
            if box[0] >= box[2] or box[1] >= box[3]:
                raise bad("批注区域不能为空")
            result["box"] = box
        if "at" in anchor or "end" in anchor:
            points = [anchor.get("at")] + ([anchor["end"]] if "end" in anchor else [])
            if not version or target.get("type") not in ("video","audio") or any(
                    type(point) not in (int,float) or not 0 <= point <= 86_400 for point in points):
                raise bad("评论时间点无效")
            duration = version.get("seconds")
            if type(duration) in (int,float) and duration > 0:
                if any(point > duration + 0.05 for point in points):
                    raise bad("评论时间点超出素材时长")
                points = [min(point,duration) for point in points]
            points = [round(point,3) for point in points]
            result["at"] = points[0]
            if len(points) == 2:
                if points[1] <= points[0]:
                    raise bad("批注结束时间必须晚于开始时间")
                result["end"] = points[1]
        return result
    if "box" in anchor or "passage" in anchor:
        raise bad("区域或段落批注需要指定素材节点")
    x, y = anchor.get("x"), anchor.get("y")
    if not all(type(n) in (int, float) and abs(n) <= 1_000_000 for n in (x, y)):
        raise bad("评论位置超出画布范围")
    return {"x":round(x, 2), "y":round(y, 2)}


def can_resolve_comment(user, board, author):
    return user["id"] in (board.get("owner"), author) or user["role"] == "admin"


@routes.get("/api/board/{bid}/comments")
async def list_comments(req):
    bid, board = comment_board(req)
    rows = db.q("""SELECT c.*, COALESCE(NULLIF(u.name,''),u.username,'已注销用户') AS author
                   FROM canvas_comments c LEFT JOIN users u ON c.author_id=u.id
                   WHERE c.board_id=? ORDER BY created,id""", bid)
    threads = {}
    nodes = {n["id"]:n for n in board.get("nodes",[])}
    for row in rows:
        item = {k:row[k] for k in ("id", "body", "author", "created")}
        if row["thread_id"] is None:
            anchor = json.loads(row["anchor"] or "null")
            threads[row["id"]] = {**item, "anchor":document_review.visible_anchor(anchor), "resolved":bool(row["resolved"]),
                                  "can_resolve":can_resolve_comment(req["user"], board, row["author_id"]), "replies":[]}
            if anchor and (passage := anchor.get("passage")):
                node = nodes.get(anchor.get("node"))
                text = (node.get("data") or {}).get("text") if node and node.get("type") == "text" else None
                threads[row["id"]]["passage_location"] = document_review.locate(text,passage) if isinstance(text,str) else None
        elif row["thread_id"] in threads:
            threads[row["thread_id"]]["replies"].append(item)
    return web.json_response(list(threads.values())[::-1])


@routes.post("/api/board/{bid}/comments")
async def post_comment(req):
    payload = await req.json()
    bid, board = comment_board(req)
    text = payload.get("body") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 2000:
        raise bad("评论须为 1–2000 字")
    key = payload.get("request_key")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", key):
        raise bad("评论请求编号无效")
    uid = req["user"]["id"]
    prior = db.one("SELECT id,thread_id FROM canvas_comments WHERE board_id=? AND author_id=? AND request_key=?", bid, uid, key)
    if prior:
        return web.json_response(prior)
    thread_id = payload.get("thread_id")
    if thread_id is not None:
        if not isinstance(thread_id, str):
            raise bad("评论编号无效")
        if comment_thread(bid, thread_id)["resolved"]:
            raise bad("此讨论已解决，请先重新打开")
    anchor = None if thread_id else comment_anchor(board, payload.get("anchor"))
    cid = "c" + uuid.uuid4().hex[:20]
    db.run("""INSERT INTO canvas_comments(id,board_id,thread_id,anchor,author_id,body,created,request_key)
              VALUES(?,?,?,?,?,?,?,?)""", cid, bid, thread_id, json.dumps(anchor, ensure_ascii=False), uid, text.strip(), time.time(), key)
    req.app["canvas_live"].comments_changed(bid)
    return web.json_response({"id":cid, "thread_id":thread_id}, status=201)


@routes.patch("/api/board/{bid}/comments/{cid}")
async def resolve_comment(req):
    payload = await req.json()
    bid, board = comment_board(req)
    row = comment_thread(bid, req.match_info["cid"])
    if not can_resolve_comment(req["user"], board, row["author_id"]):
        raise web.HTTPForbidden()
    resolved = payload.get("resolved") if isinstance(payload, dict) else None
    if type(resolved) is not bool:
        raise bad("评论状态无效")
    if bool(row["resolved"]) != resolved:
        db.run("UPDATE canvas_comments SET resolved=? WHERE id=?", int(resolved), row["id"])
        req.app["canvas_live"].comments_changed(bid)
    return web.json_response({"ok":True})


def refs_of_user(u: dict) -> set:
    seen = set()
    for f in BOARDS.glob("*.json"):
        b = board_meta(f)
        if b and can_see(u, b):
            for n in b.get("nodes", []):
                for v in n.get("versions", []):
                    seen.add(v.get("ref"))
    return seen


def media_references(value, field=""):
    if isinstance(value, str):
        if not (field in {"ref", "refs", "url", "cover", "source", "base", "mask", "overlay", "mid",
                          "remake_audio", "first_frame", "corrections", "replacement_corrections", "protections"}
                or field.endswith(("_ref", "_url", "_mask"))):
            return set()
        if value.startswith("/media?ref="):
            value = unquote(value.removeprefix("/media?ref=").split("#", 1)[0].split("&", 1)[0])
        return {value} if value.startswith(("input:h3studio/", "output:h3studio/")) else set()
    if isinstance(value, (dict, list)):
        refs = set()
        if isinstance(value, dict):
            for key, item in value.items():
                refs.update(media_references(item, field if key.isdecimal() else key))
        else:
            for item in value:
                refs.update(media_references(item, field))
        return refs
    return set()


def grant_media(user, *refs):
    for ref in refs:
        if ref:
            db.run("INSERT OR IGNORE INTO media_grants VALUES(?,?)", ref, user["id"])


def can_read_media(user, ref, *, seen=frozenset()):
    if user["role"] == "admin":
        return True
    uid = user["id"]
    if (db.one("SELECT 1 FROM memory_uploads WHERE ref=? AND owner=?", ref, uid)
            or db.one("SELECT 1 FROM media_grants WHERE ref=? AND user_id=?", ref, uid)
            or db.one("SELECT 1 FROM memory_outputs WHERE ref=? AND owner=?", ref, uid)
            or db.one("""SELECT 1 FROM tasks, json_each(CASE WHEN json_valid(tasks.outputs) THEN tasks.outputs END)
                         WHERE user_id=? AND json_each.value=? LIMIT 1""", uid, ref)):
        return True
    if ref in seen:
        return False
    if re.fullmatch(r"(?:input:h3studio/editbase|output:h3studio/edit-layer)_[^/]+\.png",ref):
        for row in db.q("SELECT request FROM tasks WHERE user_id=? AND capability='image' AND state='done' AND instr(request,?)>0",uid,ref):
            edits = task_settings(row["request"]).get("image_edits")
            if not isinstance(edits,dict):
                continue
            for edit in edits.values():
                if not isinstance(edit,dict):
                    continue
                layer = edit.get("layer")
                if ref != edit.get("base") and (not isinstance(layer,dict) or ref != layer.get("ref")):
                    continue
                source = edit.get("source")
                if isinstance(source,str) and source != ref and can_read_media(user,source,seen=seen | {ref}):
                    return True
    for row in db.q("SELECT board,data FROM video_remakes WHERE owner=? AND instr(data,?)>0", uid, ref):
        board = board_meta(board_path(row["board"]))
        if board and can_see(user, board) and ref in media_references(json.loads(row["data"])):
            return True
    if db.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_selections'") and db.one(
        """SELECT 1 FROM chat_selections s JOIN chat_sessions c ON c.id=s.session_id
           WHERE c.user_id=? AND (s.mask_ref=? OR s.preview_ref=?) LIMIT 1""", uid, ref, ref
    ):
        return True
    for path in BOARDS.glob("*.json"):
        board = board_meta(path)
        if board and can_see(user, board) and ref in media_references(board):
            return True
    store = creative_memory.Store(sys.modules[__name__])
    teams = store.teams(user)
    for asset in store.all():
        if ref not in media_references(asset.get("media", [])):
            continue
        if asset["board"]:
            board = board_meta(board_path(asset["board"]))
            if not board or not can_see(user, board):
                continue
        if asset["board"] or store.visible(asset,user,teams=teams):
            return True
    for path in (SAMPLES / "samples.json", *(SAMPLES / "boards").glob("*.json")):
        try:
            if ref in media_references(json.loads(path.read_text())):
                return True
        except (OSError, ValueError):
            continue
    return False


def require_media(user, refs):
    if user["role"] != "admin" and any(not can_read_media(user, ref) for ref in refs):
        raise web.HTTPForbidden(text=json.dumps({"error": "没有权限访问所选素材"}, ensure_ascii=False),
                                content_type="application/json")


@web.middleware
async def media_input_guard(req, handler):
    if req.method == "POST" and (req.path in {
        "/api/preview", "/api/generate", "/api/lastframe", "/api/rewrite", "/api/storyboard",
        "/api/describe", "/api/analyze", "/api/split", "/api/concat", "/api/render", "/api/render/check", "/api/cover",
        "/api/video/trim", "/api/video/captions",
    } or req.path.startswith("/api/image-edit/")):
        try:
            payload = await req.json()
        except (ValueError, UnicodeError):
            raise bad("请求格式不正确") from None
        require_media(req["user"], media_references(payload))
    return await handler(req)


@routes.get("/api/assets")
async def assets(req):
    u = req["user"]
    mine = None if u["role"] == "admin" else refs_of_user(u)
    out = []
    for kind in ("output", "input"):
        d = COMFY_DIR / kind / "h3studio"
        if not d.is_dir():
            continue
        for f in d.iterdir():
            ext = f.suffix.lower()
            if ext not in CANVAS_MEDIA_EXT or f.name.startswith("shotmid_"):
                continue
            ref = f"{kind}:h3studio/{f.name}"
            if mine is not None and ref not in mine:
                continue
            src = ("concat" if f.name.startswith("cut_") else "gen") if kind == "output" else (
                "frame" if f.name.startswith(("last_", "shot_")) else "tile" if f.name.startswith("tile")
                else "gen" if ext in AUDIO_MEDIA_EXT and f.name.startswith("narr_") else "upload")
            typ = "video" if ext in tools.VIDEO_EXT else "audio" if ext in AUDIO_MEDIA_EXT else "image"
            out.append({"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "type": typ,
                        "source": src,
                        "mtime": f.stat().st_mtime})
    out.sort(key=lambda a: -a["mtime"])
    return web.json_response(out[:300])


@routes.post("/api/upload")
async def upload(req):
    reader = await req.multipart()
    part = await reader.next()
    ext = os.path.splitext(part.filename or "x.png")[1].lower() or ".png"
    if ext == ".ora":
        return await upload_openraster(req, part)
    raw = await part.read(decode=False)
    name = f"u_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{ext}"
    if ext in tools.VIDEO_EXT:
        dst = COMFY_DIR / "input" / "h3studio" / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(raw)
        ref = f"input:h3studio/{name}"
        try:
            info = await asyncio.get_running_loop().run_in_executor(None, tools.video_info, dst)
        except Exception as e:
            dst.unlink(missing_ok=True)
            raise web.HTTPBadRequest(text=json.dumps({"error": f"读不了这个视频：{e}"}, ensure_ascii=False), content_type="application/json")
        db.run("INSERT OR IGNORE INTO memory_uploads VALUES(?,?,?)", ref, req["user"]["id"], time.time())
        return web.json_response({"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "type": "video", **info})
    if ext not in creative_memory.IMAGE_EXT:
        raise bad("只支持 PNG / JPG / WEBP 图片，或 MP4 / MOV / WEBM / M4V / MKV 视频")
    dst = COMFY_DIR / "input" / "h3studio" / name

    def store():
        from PIL import Image
        import io
        with Image.open(io.BytesIO(raw)) as im:     # refuses anything that is not really an image
            im.verify()
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(raw)
    try:
        await asyncio.get_running_loop().run_in_executor(None, store)
    except Exception as e:
        raise bad(f"读不了这张图片：{e}")
    ref = f"input:h3studio/{name}"
    db.run("INSERT OR IGNORE INTO memory_uploads VALUES(?,?,?)", ref, req["user"]["id"], time.time())
    return web.json_response({"ref": ref, "url": "/media?ref=" + quote(ref, safe="")})


async def upload_openraster(req, part):
    try:
        with tempfile.TemporaryFile() as source:
            limit = 64 * 1024 * 1024
            while chunk := await part.read_chunk(64 * 1024):
                if source.tell() + len(chunk) > limit:
                    raise bad("OpenRaster 文件不能超过 64 MB")
                source.write(chunk)
            result = await asyncio.to_thread(image_editor.import_openraster, COMFY_DIR, source)
    except ValueError as error:
        raise bad(str(error)) from None
    except (zipfile.BadZipFile, ParseError, OSError, KeyError, RuntimeError, DecompressionBombError):
        raise bad("读不了这个 OpenRaster 文件，请检查图层文件是否完整") from None
    grant_media(req["user"], result["ref"], *(layer["ref"] for layer in result["layer_stack"]["layers"]))
    return web.json_response(result)


@routes.get("/media")
async def media(req):
    ref = req.query.get("ref", "")
    try:
        f = tools.ref_path(COMFY_DIR, ref)
    except ValueError:
        raise web.HTTPBadRequest()
    gif = f.suffix == ".gif" and bool(showcase.EXPORTED_GIF.fullmatch(ref))
    if (f.suffix.lower() not in MEDIA_EXT and not gif) or not f.is_file():
        raise web.HTTPNotFound()
    if not can_read_media(req["user"], ref):
        raise web.HTTPNotFound()
    return web.FileResponse(f, headers={"Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff"})


routes.get(motion_reference.LEASE_PREFIX + "{token}")(motion_reference.serve)


AUDIO_MEDIA_EXT = tools.AUDIO_EXT
CANVAS_MEDIA_EXT = MEDIA_EXT = creative_memory.IMAGE_EXT | tools.VIDEO_EXT | AUDIO_MEDIA_EXT


AUDIO_GENERATION_MODES = {"tts":"配音", "music":"音乐生成", "sfx":"音效生成", "seed_audio":"参考音频生成"}
AUDIO_SETTINGS = ("voice","speed","lyrics","provider","duration_seconds","prompt_influence","loop","subtitles",
                  "audio_format","sample_rate","pitch_semitones","gain","references")
HISTORY_CAPABILITIES = {"image": ("image",), "video": ("video","render"), "audio": tuple(AUDIO_GENERATION_MODES)}
HISTORY_EXTENSIONS = {"image": creative_memory.IMAGE_EXT, "video": tools.VIDEO_EXT, "audio": AUDIO_MEDIA_EXT}


def readable_history_image_edit(edit, user, permitted):
    if not isinstance(edit,dict):
        return None
    for ref in media_references(edit):
        key = (ref,"image")
        if key not in permitted:
            try:
                permitted[key] = tools.ref_path(COMFY_DIR,ref).is_file() and can_read_media(user,ref)
            except (OSError,ValueError):
                permitted[key] = False
        if not permitted[key]:
            return None
    return edit


def history_seed_refs(recipe, user, permitted):
    selected = set()
    selected_kind = None

    def keep(item):
        nonlocal selected_kind
        ref, kind, ident = item.get("ref"), item.get("kind"), item.get("node_id")
        if not isinstance(ref,str) or kind not in ("audio","image") or not isinstance(ident,str) or not _ID.fullmatch(ident):
            return False
        if ref in selected or selected_kind not in (None,kind) or len(selected) >= (3 if kind=="audio" else 1):
            return False
        key = (ref,kind)
        if key not in permitted:
            try:
                path = tools.ref_path(COMFY_DIR,ref)
                permitted[key] = path.suffix.lower() in HISTORY_EXTENSIONS[kind] and path.is_file() and can_read_media(user,ref)
            except (OSError,ValueError):
                permitted[key] = False
        if not permitted[key]:
            return False
        selected.add(ref)
        selected_kind = kind
        return True

    return board_store.prune_seed_audio_refs(recipe,keep)


def task_settings(serialized):
    try:
        value = json.loads(serialized or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def generation_history_metadata(job):
    if job["state"] == "done" and job.get("kind") == "audio":
        transcript = next((out["extra"]["audio_transcript"] for out in job.get("outputs",[])
                           if out.get("extra",{}).get("audio_transcript")),None)
        task = db.one("SELECT request FROM tasks WHERE id=?", job["id"]) if transcript else None
        if task:
            request = task_settings(task["request"])
            request["audio_transcript"] = transcript
            return {"request":json.dumps(request,ensure_ascii=False)}
        return {}
    if job["state"] != "done" or job.get("kind") not in ("image", "video"):
        return {}
    meta = job.get("meta") or {}
    settings = {key: meta[key] for key in ("seed", "width", "height") if type(meta.get(key)) is int}
    if meta.get("prompt"):
        settings["prompt"] = clean(meta["prompt"])[:2000]
    if job["kind"] == "video":
        settings.update(video_job_details(meta))
    image_edits = {output["ref"]:output["extra"]["edit"] for output in job.get("outputs") or []
                   if job["kind"]=="image" and output.get("ref") and isinstance(output.get("extra",{}).get("edit"),dict)}
    if not settings and not image_edits:
        return {}
    task = db.one("SELECT request FROM tasks WHERE id=?", job["id"])
    if not task:
        return {}
    request = task_settings(task["request"])
    request["history"] = settings
    if image_edits:
        request["image_edits"] = image_edits
        if meta.get("mode_name"):
            settings["mode_name"] = meta["mode_name"]
    return {"request": json.dumps(request, ensure_ascii=False)}


@routes.get("/api/generation-history")
async def generation_history(req):
    user = req["user"]
    kind = req.query.get("kind", "all")
    if kind != "all" and kind not in HISTORY_CAPABILITIES:
        raise bad("不支持的历史类型")
    capabilities = sum(HISTORY_CAPABILITIES.values(), ()) if kind == "all" else HISTORY_CAPABILITIES[kind]
    conditions = ["user_id=?", "state='done'", "outputs IS NOT NULL",
                  "capability IN (" + ",".join("?" for _ in capabilities) + ")"]
    if "render" in capabilities:
        conditions.append("(capability!='render' OR json_type(CASE WHEN json_valid(request) THEN request END,'$.broll')='object')")
    params = [user["id"], *capabilities]
    if bid := req.query.get("board"):
        board = board_meta(board_path(bid))
        if not board or not can_see(user, board):
            return auth.err(404, "画布不存在或无权访问")
        conditions.append("board_id=?")
        params.append(bid)
    query = req.query.get("q", "").strip()[:120]
    if query:
        conditions.append("instr(lower(coalesce(label,'') || ' ' || coalesce(model,'') || ' ' || coalesce(request,'') || ' ' || outputs),lower(?))>0")
        params.append(query)
    if cursor := req.query.get("before"):
        if not cursor.isascii() or not cursor.isdecimal() or len(cursor) > 18 or int(cursor) < 1:
            raise bad("历史页码不正确")
        conditions.append("rowid<?")
        params.append(int(cursor))
    page_size = 24
    rows = db.q("SELECT rowid AS cursor,id,label,model,capability,finished,created,outputs,request FROM tasks WHERE " +
                " AND ".join(conditions) + " ORDER BY rowid DESC LIMIT ?", *params, page_size+1)
    items, permitted = [], {}
    for task in rows[:page_size]:
        try:
            refs = json.loads(task["outputs"])
        except (ValueError, TypeError):
            continue
        if not isinstance(refs,list):
            continue
        request = task_settings(task["request"])
        history, recipe = (request.get(key) for key in ("history", "recipe"))
        history = history if isinstance(history, dict) else {}
        recipe = recipe if isinstance(recipe, dict) else {}
        edits = request.get("image_edits")
        graphics = request.get("broll") if task["capability"]=="render" else None
        graphics_prompt = (graphics.get("title") or "\n".join(graphics.get("lines",[]))) if graphics else ""
        prompt = clean(graphics_prompt or history.get("prompt") or recipe.get("prompt") or request.get("prompt") or request.get("text"))[:2000]
        item_kind = next(kind for kind,caps in HISTORY_CAPABILITIES.items() if task["capability"] in caps)
        audio = {key: recipe[key] for key in AUDIO_SETTINGS if key in recipe}
        if item_kind == "audio":
            audio.update(mode=task["capability"], prompt=clean(recipe.get("prompt"))[:3000] or prompt)
        missing = history_seed_refs(audio,user,permitted)
        ext = HISTORY_EXTENSIONS[item_kind]
        for index, ref in enumerate(refs):
            if not isinstance(ref, str):
                continue
            try:
                file = tools.ref_path(COMFY_DIR, ref)
            except (ValueError, OSError):
                continue
            if file.suffix.lower() not in ext:
                continue
            available = file.is_file()
            saved_edit = edits.get(ref) if item_kind=="image" and isinstance(edits,dict) else None
            image_edit = readable_history_image_edit(saved_edit,user,permitted) if available else None
            dimensions = {key:history[key] for key in ("width","height") if type(history.get(key)) is int}
            if image_edit and isinstance(layer := image_edit.get("layer"),dict):
                for key, source in (("width","w"),("height","h")):
                    if type(layer.get(source)) is int:
                        dimensions[key] = layer[source]
            items.append({"id": f"{task['id']}:{index}", "type": item_kind, "ref": ref, "available": available,
                          "url": "/media?ref=" + quote(ref, safe="") if available else None,
                          "label": task["label"] or file.stem, "model": "B-roll" if graphics else task["model"], "prompt": prompt,
                          "created": task["finished"] or task["created"],
                          **({"source":"broll","broll_recipe":graphics} if graphics else {}),
                          **({"source":"edit","image_edit":image_edit} if image_edit else {}),
                          **({"image_edit_unavailable":True} if available and saved_edit and not image_edit else {}),
                          **({"audio_recipe": audio} if item_kind == "audio" else {}),
                          **({"missing_audio_references":missing} if missing else {}),
                          **({"audio_transcript":request["audio_transcript"]}
                             if item_kind == "audio" and isinstance(request.get("audio_transcript"),dict) else {}),
                          **({"seed":history["seed"]} if type(history.get("seed")) is int else {}), **dimensions})
    if items:
        saved = {row["ref"] for row in db.q("SELECT ref FROM media_favorites WHERE user_id=? AND ref IN (SELECT value FROM json_each(?))",
                                             user["id"], json.dumps([item["ref"] for item in items]))}
        for item in items:
            item["favorite"] = item["ref"] in saved
    return web.json_response({"items": items, "next": rows[page_size-1]["cursor"] if len(rows)>page_size else None},
                             headers={"Cache-Control": "private, no-store"})


@routes.get("/api/media-favorites")
async def list_media_favorites(req):
    user = req["user"]
    headers = {"Cache-Control": "private, no-store"}
    if "ref" in req.query:
        saved = db.one("SELECT 1 FROM media_favorites WHERE user_id=? AND ref=?", user["id"], req.query["ref"])
        return web.json_response({"favorite": bool(saved)}, headers=headers)
    kind = req.query.get("kind", "all")
    if kind != "all" and kind not in HISTORY_EXTENSIONS:
        raise bad("不支持的收藏类型")
    filters, params = ["user_id=?"], [user["id"]]
    if kind != "all":
        filters.append("kind=?")
        params.append(kind)
    if query := req.query.get("q", "").strip()[:120]:
        filters.append("instr(lower(label || ' ' || data),lower(?))>0")
        params.append(query)
    if cursor := req.query.get("before"):
        if not cursor.isascii() or not cursor.isdecimal() or len(cursor)>18 or int(cursor)<1:
            raise bad("收藏页码不正确")
        filters.append("rowid<?")
        params.append(int(cursor))
    page_size = 24
    rows = db.q("SELECT rowid AS cursor,ref,kind,label,data,created FROM media_favorites WHERE " +
                " AND ".join(filters) + " ORDER BY rowid DESC LIMIT ?", *params, page_size+1)
    items, permitted = [], {}
    for row in rows[:page_size]:
        ref = row["ref"]
        try:
            available = tools.ref_path(COMFY_DIR,ref).is_file() and can_read_media(user,ref)
        except (ValueError,OSError):
            available = False
        data = task_settings(row["data"])
        missing = data.pop("missing_audio_references",0) + history_seed_refs(data.get("audio_recipe"),user,permitted)
        items.append({**data, **({"missing_audio_references":missing} if missing else {}),
                      "id":ref, "ref":ref, "label":row["label"], "type":row["kind"],
                      "created":row["created"], "favorite":True, "available":available,
                      "url":"/media?ref=" + quote(ref,safe="") if available else None})
    return web.json_response({"items":items,"next":rows[page_size-1]["cursor"] if len(rows)>page_size else None}, headers=headers)


@routes.post("/api/media-favorites")
async def update_media_favorite(req):
    user = req["user"]
    payload = await req.json()
    if not isinstance(payload,dict) or type(payload.get("favorite")) is not bool or not isinstance(payload.get("ref"),str):
        raise bad("收藏请求不正确")
    ref, favorite = payload["ref"], payload["favorite"]
    if not favorite:
        db.run("DELETE FROM media_favorites WHERE user_id=? AND ref=?",user["id"],ref)
        return web.json_response({"favorite":False})
    try:
        path = tools.ref_path(COMFY_DIR,ref)
    except (ValueError,OSError):
        raise bad("素材引用不正确") from None
    kind = next((kind for kind,extensions in HISTORY_EXTENSIONS.items() if path.suffix.lower() in extensions),None)
    if not kind or not path.is_file() or not can_read_media(user,ref):
        return auth.err(404,"素材不存在或无权访问")
    data = {key: clean(payload.get(key))[:limit] for key,limit in (("prompt",2000),("model",160),("source",40))}
    data.update({key:payload[key] for key in ("width","height") if type(payload.get(key)) is int and 0<payload[key]<=32768})
    if type(payload.get("seed")) is int and abs(payload["seed"]) < 2**53:
        data["seed"] = payload["seed"]
    recipe = payload.get("audio_recipe")
    if kind == "audio" and isinstance(recipe,dict):
        data["audio_recipe"] = {key:clean(recipe.get(key))[:120] for key in ("voice","provider")}
        if isinstance(recipe.get("lyrics"),str):
            data["audio_recipe"]["lyrics"] = recipe["lyrics"][:3000]
        mode = recipe.get("mode")
        data["audio_recipe"].update(mode=mode if isinstance(mode,str) and mode in AUDIO_GENERATION_MODES else "tts",
                                   prompt=clean(recipe.get("prompt"))[:3000] or data["prompt"])
        if type(recipe.get("speed")) in (int,float) and .5 <= recipe["speed"] <= 2:
            data["audio_recipe"]["speed"] = recipe["speed"]
        if mode in ("tts","seed_audio") and recipe.get("subtitles") is True:
            data["audio_recipe"]["subtitles"] = True
        if mode == "seed_audio" and isinstance(recipe.get("references"),list):
            keys = ("node_id","ref","kind")
            data["audio_recipe"]["references"] = [{key:item.get(key) for key in keys} if isinstance(item,dict) else None
                                                   for item in recipe["references"][:3]]
            if missing := history_seed_refs(data["audio_recipe"],user,{}):
                data["missing_audio_references"] = missing
        output = recipe.get("audio_format")
        rate = recipe.get("sample_rate")
        if isinstance(output,str) and output in film.AUDIO_OUTPUT_RATES and type(rate) is int and rate in film.AUDIO_OUTPUT_RATES[output]:
            data["audio_recipe"].update(audio_format=output,sample_rate=rate)
        pitch, gain = recipe.get("pitch_semitones"), recipe.get("gain")
        if type(pitch) is int and -12 <= pitch <= 12:
            data["audio_recipe"]["pitch_semitones"] = pitch
        if type(gain) in (int,float) and .5 <= gain <= 2:
            data["audio_recipe"]["gain"] = gain
        if mode == "sfx":
            if type(recipe.get("duration_seconds")) in (int,float) and .5 <= recipe["duration_seconds"] <= 30:
                data["audio_recipe"]["duration_seconds"] = recipe["duration_seconds"]
            if type(recipe.get("prompt_influence")) in (int,float) and 0 <= recipe["prompt_influence"] <= 1:
                data["audio_recipe"]["prompt_influence"] = recipe["prompt_influence"]
            if type(recipe.get("loop")) is bool:
                data["audio_recipe"]["loop"] = recipe["loop"]
    label = clean(payload.get("label"))[:120] or path.stem
    db.run("INSERT OR IGNORE INTO media_favorites(user_id,ref,kind,label,data,created) VALUES(?,?,?,?,?,?)",
           user["id"],ref,kind,label,json.dumps(data,ensure_ascii=False),time.time())
    return web.json_response({"favorite":True})


def apply_fields(p: dict, for_llm: bool = False) -> dict:
    """Video nodes filled in field by field: merge the fields into prompt / sound / music."""
    f = p.get("fields")
    if p.get("kind", "video") != "video" or not isinstance(f, dict):
        return p
    if not pfields.has_content(f):
        raise web.HTTPBadRequest(text=json.dumps({"error": "至少填写场景、动作或对话中的一项"}, ensure_ascii=False), content_type="application/json")
    # character references: match 人物 names to the reference images (image node name / caption, or 1 person ↔ 1 image)
    subj, imgs = {}, [dict(im) for im in (p.get("images") or [])]
    if p.get("planned"):
        ppl = pfields.people(f)
        refs = [im for im in imgs if im.get("role") == "subject"][:9]
        for im in refs:   # a named character image (e.g. from the asset library) counts even if 人物 doesn't list it
            if not is_character_reference(im):
                continue
            canonical = clean(im.get("memory_name"))
            nm = canonical or (im.get("name") or "").strip()
            if canonical or (nm and not re.fullmatch(r"(图片|image)\s*\d+.*", nm, re.I) and not any(n in nm for n in ppl)):
                ppl.setdefault(nm, clean(im.get("caption")) or "the character in the reference image")
        for k, im in enumerate(refs):
            if not is_character_reference(im):
                continue
            label = f"{im.get('name') or ''} {im.get('caption') or ''}"
            hit = clean(im.get("memory_name")) or next((n for n in ppl if n in label), None)
            if hit is None and len(ppl) == 1 and len(refs) == 1:
                hit = next(iter(ppl))
            if hit and hit not in subj:
                subj[hit] = k + 1
                im["caption"] = f"{hit}, {ppl[hit]}"
                voice = clean(next((a.get("voice") for a in lib_load() if a.get("id") == im.get("asset")), "") if im.get("asset") else "")
                if voice and voice not in (f.get("people") or ""):
                    f = dict(f)
                    lines = (f.get("people") or "").splitlines()
                    at = next((i for i, ln in enumerate(lines) if re.match(rf"\s*{re.escape(hit)}\s*[:：]", ln)), None)
                    if at is None:
                        lines.append(f"{hit}：{ppl[hit]}，声音：{voice}")
                    else:
                        lines[at] = lines[at].rstrip("。.，, ") + f"，声音：{voice}"
                    f["people"] = "\n".join(lines)
    if for_llm:
        prompt, snd, mus = pfields.for_rewriter(f, p.get("prompt") or "", subj), pfields._one(f.get("sound")), pfields._one(f.get("music"))
    else:
        prompt, snd, mus = pfields.compose(f, p.get("prompt") or "", subj)
    return {**p, "prompt": prompt, "sound": snd, "music": mus, "images": imgs}


_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
_DBLOCK = re.compile(r"<d>.*?</d>", re.S)
_IMAGE_MENTION = re.compile(r"@图(\d+)")
_MARKS = re.compile(r"<(?:Picture|Subject|Video|Audio) \d+>|\(S\d+(?:,S\d+)*\)|<d>.*?</d>|@图\d+", re.S)
XLATE_FILE = DATA / "xlate_cache.json"
try:
    _XLATE_CACHE: dict = json.loads(XLATE_FILE.read_text())
except Exception:
    _XLATE_CACHE = {}
XLATE_SYSTEM = """You translate the parts of a video-generation prompt from Chinese into natural, concrete English.
Input: a JSON object. Output: ONLY a JSON object with exactly the same keys and the same list lengths, every value translated.
Rules:
- Translate faithfully; do not add, drop or reorder actions, objects, counts, positions or constraints.
- Copy these verbatim, unchanged: every <d>...</d> block including its content and [Language] tag, every @图N image mention, every <Picture N>, <Subject N>, <Video N>, <Audio N>, and every speaker ID such as (S1).
- Text that appears in double quotation marks as visible on-screen text stays as it is.
- Write descriptions, not speech. Use plain prose; no markdown, no explanations."""


def _needs_english(t: str) -> bool:
    return bool(t) and bool(_CJK.search(_IMAGE_MENTION.sub("", _DBLOCK.sub("", t))))


async def to_english(app, p: dict) -> dict:
    """H3's prompt format is English except dialogue/lyrics in <d> and visible text. Translate the rest before generation."""
    if p.get("kind", "video") != "video":
        return p
    prompt = p.get("prompt") or ""
    structured = any(k in prompt for k in ("subject_definitions:", "integrated_multimodal_description:"))
    src = {}
    if not structured and _needs_english(prompt):
        src["prompt"] = prompt
    for k in ("sound", "music"):
        if _needs_english(p.get(k) or ""):
            src[k] = p[k]
    imgs = [dict(im) for im in (p.get("images") or [])]
    caps = [i for i, im in enumerate(imgs) if _needs_english(im.get("caption") or "")]
    if caps:
        src["captions"] = [imgs[i]["caption"] for i in caps]
    if not src:
        return p
    key = json.dumps(src, ensure_ascii=False, sort_keys=True)
    if any(_IMAGE_MENTION.search(value) for entry in src.values() for value in (entry if isinstance(entry, list) else [entry])):
        key = "image-mentions:" + key
    out = _XLATE_CACHE.get(key)
    if out is None:
        llm = app["llm"]
        if not llm.available():
            return {**p, "_xlate_err": "没有可用的文本模型"}
        try:
            text = await llm.chat(XLATE_SYSTEM, json.dumps(src, ensure_ascii=False, indent=1), max_tokens=4000, temperature=0.2)
            text = rewriter.strip_fences(text)
            out = json.loads(text[text.index("{"): text.rindex("}") + 1])
            for k, v in src.items():
                o = out.get(k)
                if k == "captions":
                    if not isinstance(o, list) or len(o) != len(v):
                        raise ValueError("captions mismatch")
                    o = [str(x) for x in o]
                    out[k] = o
                elif not isinstance(o, str) or not o.strip():
                    raise ValueError(f"{k} missing")
                for a, b in (zip(v, o) if k == "captions" else [(v, o)]):
                    if sorted(_MARKS.findall(a)) != sorted(_MARKS.findall(b)):
                        raise ValueError(f"{k}: markers or <d> blocks changed")
                    if _needs_english(b):
                        raise ValueError(f"{k}: still Chinese")
        except Exception as e:
            print(f"to_english failed: {e}", flush=True)
            return {**p, "_xlate_err": str(e)[:200]}
        if len(_XLATE_CACHE) > 500:
            for k in list(_XLATE_CACHE)[:100]:
                del _XLATE_CACHE[k]
        _XLATE_CACHE[key] = out
        try:
            tmp = XLATE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(_XLATE_CACHE, ensure_ascii=False))
            os.replace(tmp, XLATE_FILE)
        except Exception as e:
            print(f"xlate cache save failed: {e}", flush=True)
    q = {**p}
    for k in ("prompt", "sound", "music"):
        if k in src:
            q[k] = out[k]
    for i, c in zip(caps, out.get("captions", [])):
        imgs[i]["caption"] = c
    q["images"] = imgs
    return q


@routes.post("/api/preview")
async def preview(req):
    """Preview the prepared video prompt and its configured media without submitting a job."""
    raw = await req.json()
    replay_ref = checked_asset_replay(raw)
    payload = apply_video_optics(req.app["creative_memory"].prepare(req["user"],raw,replay_ref=replay_ref))
    if payload.get("previs_guide") is not None or payload.get("audio_refs") or payload.get("video_refs"):
        retake = resolve_camera_plan(payload)
        object_plan = resolve_object_edit(payload)
        mode = ("镜头重拍" if retake else
                object_edit.ACTIONS[object_plan["action"]] if object_plan else "全模态参考")
        review = await describe_video_references(req["user"],payload,object_plan)
        resolution = review["quality"]
        mode += f" · {review['provider']} · {review['model']} · {review['duration']:g} 秒 · {resolution}"
        mode += "".join(f" · {label} {count}/{limit}" for label,count,limit in review["counts"] if count)
        inputs = review["inputs"]
        for item in inputs:
            if item.get("role") in ("subject", "frame"):
                set_video_preview_image_role(item,"image_ref")
        return web.json_response({"prompt": review["prompt"], "mode": mode, "inputs": inputs,
                                  "duration":review["duration"], "reference_preview":review["key"]})
    inputs = workflow_review.capture_generation(payload)["inputs"]
    route = requested_generation_route(payload, "video")
    if route and route["provider"]["kind"] != "local_h3":
        resolution = checked_video_resolution(payload,route["provider"]["kind"],route["model"],provider=route["provider"])
        prompt, roles = remote_video_prompt(payload, route["provider"], route["model"])
        if not prompt:
            raise bad("提示词不能为空")
        mode = f"{route['provider']['name']} · {route['model']} · {resolution}"
        if limit := image_reference_limit(payload,route["provider"],route["model"]):
            resolve_video_reference_images(req["user"],payload)
            inputs = numbered_reference_inputs(inputs,payload,h3_labels=is_cloud_h3(route["provider"],route["model"]))
            seconds = reference_video_duration(payload,route["provider"],route["model"],None)
            mode += f" · {seconds:g} 秒 · 参考图 {len(inputs)}/{limit}"
            if any(entry.get("role")!="subject" for entry in inputs):
                mode += " · 关键帧构图由提示词引导"
        for item, role in zip(inputs, roles):
            set_video_preview_image_role(item,role)
        details = {}
        if limit:
            details["reference_preview"] = reference_preview_fingerprint(payload,route,guide_frames=True)
            details["duration"] = seconds
        return web.json_response({"prompt": prompt, "mode": mode, "inputs": inputs, **details})
    resolution = checked_video_resolution(payload,"local_h3","h3-video")
    p = apply_fields(payload)
    if not clean(p.get("prompt")):
        raise web.HTTPBadRequest(text=json.dumps({"error": "提示词为空"}, ensure_ascii=False), content_type="application/json")
    p = await to_english(req.app, p)
    _, meta = graph_video(p)
    if meta.get("mode") == "fl2v" and len(inputs) > 1:
        inputs[-1]["role"] = "last_frame"
    mode = " · ".join(filter(None,(meta.get("mode_name"), "本地 H3", resolution)))
    if p.get("_xlate_err"):
        mode += " · 未翻译成英文：" + p["_xlate_err"]
    return web.json_response({"prompt": meta.get("full_prompt", p["prompt"]), "mode": mode, "inputs": inputs})


@routes.post("/api/generate")
async def generate(req):
    raw = await req.json()
    # Only the validated editor endpoint may provide a compositing specification.
    raw.pop("_image_edit", None)
    raw.pop("_native_inpaint", None)
    raw.pop("_preserve_speech_motion", None)
    if replay_ref := checked_asset_replay(raw):
        req["replay_memory_ref"] = replay_ref
    if (preview_key := raw.pop("reference_preview",None)) is not None:
        if not isinstance(preview_key,str) or not re.fullmatch(r"[a-f0-9]{64}",preview_key):
            raise bad("素材预览编号无效")
        req["reference_preview"] = preview_key
    if (asset_key := raw.pop("asset_review_key",None)) is not None:
        if not isinstance(asset_key,str) or not re.fullmatch(r"[a-f0-9]{64}",asset_key):
            raise bad("资产核对编号无效")
        req["asset_review_key"] = asset_key
    return await generate_request(req, raw)


def checked_asset_replay(raw):
    ref = raw.pop("replay_memory_ref",None)
    if ref is None:
        return None
    try:
        if not isinstance(ref,str) or not ref:
            raise ValueError()
        tools.ref_path(COMFY_DIR,ref)
    except ValueError:
        raise bad("历史生成版本无效") from None
    return ref


@routes.post("/api/image-edit/transform")
async def image_transform(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise bad("图像编辑参数须为对象")
    try:
        r = await asyncio.to_thread(image_editor.transform, COMFY_DIR, p)
    except (ValueError, OSError, TypeError) as e:
        raise bad(str(e))
    grant_media(req["user"], r.get("ref"))
    return web.json_response(r)


@routes.post("/api/image-edit/layers")
@routes.post("/api/image-edit/selection-cutout")
async def image_layers(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise bad("图像编辑参数须为对象")
    try:
        fn = image_editor.cut_selection if req.path.endswith("selection-cutout") else image_editor.compose_layers
        result = await asyncio.to_thread(fn, COMFY_DIR, p)
    except (ValueError, OSError, TypeError) as e:
        raise bad(str(e))
    grant_media(req["user"], result.get("ref"))
    return web.json_response(result)


@routes.post("/api/image-edit/openraster")
async def image_openraster(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise bad("图层导出参数须为对象")
    directory = DATA / "exports"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (uuid.uuid4().hex + ".ora")

    def build():
        try:
            image_editor.export_openraster(COMFY_DIR, p, destination)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        cutoff = time.time() - 86400
        for old in directory.glob("*.ora"):
            try:
                if old.stat().st_mtime < cutoff:
                    old.unlink(missing_ok=True)
            except FileNotFoundError:
                continue

    try:
        await asyncio.to_thread(build)
    except (ValueError, OSError, TypeError) as error:
        raise bad(str(error)) from None
    name = image_editor.ora_name(p.get("name"), "OneShot")
    filename = quote(re.sub(r'[\\/:*?"<>|]', "_", name) + ".ora", safe="")
    headers = {"Content-Disposition": f"attachment; filename=\"OneShot.ora\"; filename*=UTF-8''{filename}",
               "Content-Type": "image/openraster", "Cache-Control": "no-store"}
    return web.FileResponse(destination, headers=headers)


def image_draft_path(req, ref):
    bid, nid = req.match_info["board"], req.match_info["node"]
    if not _ID.fullmatch(nid):
        raise bad("节点编号格式不对")
    board = board_path(bid)
    if not board.exists() or not can_see(req["user"], board_meta(board)):
        raise web.HTTPNotFound()
    try:
        tools.ref_path(COMFY_DIR, ref)
    except ValueError:
        raise bad("图片引用格式不对")
    key = hashlib.sha256(f'{req["user"]["id"]}:{bid}:{nid}:{ref}'.encode()).hexdigest()
    return DATA / "image-drafts" / (key + ".json")


@routes.get("/api/image-edit/drafts/{board}/{node}")
async def image_draft_get(req):
    path = image_draft_path(req, req.query.get("ref", ""))
    try:
        result = json.loads(await asyncio.to_thread(path.read_text))
    except FileNotFoundError:
        result = None
    return web.json_response(result)


@routes.put("/api/image-edit/drafts/{board}/{node}")
@routes.post("/api/image-edit/drafts/{board}/{node}")
async def image_draft_save(req):
    p = await req.json()
    if not isinstance(p, dict) or not isinstance(p.get("ref"), str):
        raise bad("草稿格式不正确")
    path = image_draft_path(req, p["ref"])
    try:
        raw = json.dumps(p, ensure_ascii=False, allow_nan=False)
    except ValueError:
        raise bad("草稿包含无效数值")
    if len(raw.encode()) > 8 * 1024 * 1024:
        raise bad("草稿过大，请减少选区笔画或图层")
    def write():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.stem + "." + uuid.uuid4().hex[:8] + ".tmp")
        tmp.write_text(raw); tmp.replace(path)
    await asyncio.to_thread(write)
    return web.json_response({"ok": True})


@routes.get("/api/image-edit/capabilities")
async def image_edit_capabilities(req):
    capabilities = {"segment": False, "cutout": False, "native": False, "decompose": False}
    try:
        async with req.app["http"].get(ENGINE + "/status", timeout=aiohttp.ClientTimeout(total=4)) as r:
            s = await r.json()
        capabilities.update(s.get("editor", {}))
    except Exception:
        pass
    capabilities["upscale"] = await asyncio.to_thread(image_upscale.available_scales, IMAGE_UPSCALE_MODELS)
    return web.json_response(capabilities)


@routes.post("/api/image-edit/upscale")
async def image_upscale_route(req):
    p = await req.json()
    if not isinstance(p, dict) or not isinstance(p.get("ref"), str):
        raise bad("请选择要放大的图片")
    require_media(req["user"], [p["ref"]])
    try:
        result = await asyncio.to_thread(image_upscale.upscale, COMFY_DIR, IMAGE_UPSCALE_MODELS,
                                         p["ref"], p.get("scale"))
    except (ValueError, OSError) as error:
        raise bad(str(error)) from None
    grant_media(req["user"], result["ref"])
    return web.json_response(result)


@routes.post("/api/image-edit/segment")
@routes.post("/api/image-edit/cutout")
async def image_edit_tool(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise bad("图像编辑参数须为对象")
    tool = req.path.rsplit("/", 1)[-1]
    result = await run_image_tool(req.app, tool, p)
    grant_media(req["user"], result.get("ref"))
    return web.json_response(result)


@routes.post("/api/image-edit/decompose")
async def image_decompose_route(req):
    p = await req.json()
    if not isinstance(p, dict) or not isinstance(p.get("ref"), str):
        raise bad("请选择要分层的图片")
    require_media(req["user"],[p["ref"]])
    labels = await run_image_tool(req.app,"decompose",p)
    path = tools.ref_path(COMFY_DIR,labels["ref"])
    try:
        result = await asyncio.to_thread(image_editor.decompose,COMFY_DIR,p["ref"],labels["ref"])
    except (ValueError,OSError) as error:
        raise bad(str(error)) from None
    finally:
        path.unlink(missing_ok=True)
    grant_media(req["user"],result["ref"])
    for layer in result["layer_stack"]["layers"]:
        grant_media(req["user"],layer["ref"])
    return web.json_response(result)


@routes.post("/api/image-edit/fill-background")
async def image_fill_background_route(req):
    p = await req.json()
    if not isinstance(p, dict) or not all(isinstance(p.get(key), str) for key in ("ref", "background")):
        raise bad("请选择要补全的分层背景")
    require_media(req["user"],[p["ref"],p["background"]])
    try:
        result = await asyncio.to_thread(image_editor.fill_background, COMFY_DIR, p["ref"], p["background"],
                                         p.get("x"), p.get("y"))
    except (ImportError, ValueError, OSError) as error:
        raise bad(str(error)) from None
    grant_media(req["user"], result["ref"])
    return web.json_response(result)


async def run_image_tool(app, tool, p):
    try:
        image = tools.ref_path(COMFY_DIR, p.get("ref", ""))
        await asyncio.to_thread(image_editor.load, COMFY_DIR, p.get("ref", ""))
        prefix = {"segment":"selection","cutout":"cutout","decompose":"layer_labels"}[tool]
        out, ref = tools._new(COMFY_DIR, "output", prefix, ".png")
        async with app["http"].post(ENGINE + "/tools/" + tool,
                                       json={"image": str(image), "points": p.get("points"), "out": str(out)},
                                       timeout=aiohttp.ClientTimeout(total=180)) as r:
            result = await r.json()
            if r.status != 200:
                raise ValueError(result.get("error") or "图像工具执行失败")
        return {"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "w": result["width"], "h": result["height"],
                "score": result.get("score")}
    except (ValueError, OSError, TypeError, aiohttp.ClientError, asyncio.TimeoutError) as e:
        raise bad(str(e) or "图像工具暂时不可用")


def resolve_asset_exports(user, refs):
    if not isinstance(refs, list) or not 1 <= len(refs) <= 100 or not all(isinstance(ref, str) for ref in refs):
        raise bad("请选择 1–100 个素材")
    allowed = None if user["role"] == "admin" else refs_of_user(user)
    paths = []
    for ref in dict.fromkeys(refs):
        try:
            path = tools.ref_path(COMFY_DIR, ref)
        except ValueError:
            raise bad("素材引用不正确")
        if (allowed is not None and ref not in allowed and not can_read_media(user,ref)) or not path.is_file() or path.suffix.lower() not in MEDIA_EXT:
            raise bad("素材不存在或没有访问权限")
        paths.append(path)
    return paths


@routes.post("/api/assets/export")
async def export_assets(req):
    p = await req.json()
    paths = resolve_asset_exports(req["user"],p.get("refs") if isinstance(p,dict) else None)
    return await serve_asset_archive([(f"{i:02d}_{path.name}",path) for i,path in enumerate(paths,1)],"OneShot-assets.zip")


@routes.post("/api/assets/transfers")
async def start_asset_transfer(req):
    p = await req.json()
    refs = p.get("refs") if isinstance(p,dict) else None
    paths = resolve_asset_exports(req["user"],refs)
    name = p.get("name","OneShot-素材.zip")
    if not isinstance(name,str):
        raise bad("下载文件名无效")
    name = re.sub(r'[\x00-\x1f/\\]',"_",name.strip().removesuffix(".zip"))[:100] or "OneShot-素材"
    try:
        item = asset_transfers.start(req["user"]["id"],list(dict.fromkeys(refs)),paths,name+".zip",DATA/"transfers")
    except OSError:
        raise bad("源文件已失效，请重新选择素材") from None
    return web.json_response(asset_transfers.describe(item),status=202)


@routes.get("/api/assets/transfers/{key}")
async def asset_transfer_status(req):
    item = asset_transfers.lookup(req["user"]["id"],req.match_info["key"])
    return web.json_response(asset_transfers.describe(item),headers={"Cache-Control":"no-store"})


@routes.get("/api/assets/transfers/{key}/file",allow_head=False)
async def download_asset_transfer(req):
    item = asset_transfers.lookup(req["user"]["id"],req.match_info["key"])
    try:
        resolve_asset_exports(req["user"],item["refs"])
    except web.HTTPException:
        if item["state"] in ("ready","sent"):
            asset_transfers.update(item,"error",error="下载权限或源文件已变化，请重新选择素材")
        raise
    return await asset_transfers.send(req,item)


async def serve_asset_archive(entries, filename):
    directory = DATA / "exports"; directory.mkdir(parents=True, exist_ok=True)
    dst = directory / (uuid.uuid4().hex + ".zip")
    def archive():
        try:
            with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
                for name, content in entries:
                    if isinstance(content,bytes):
                        z.writestr(name,content)
                    else:
                        z.write(content,name)
        except Exception:
            dst.unlink(missing_ok=True)
            raise
        # Exports contain only references already authorized above. Remove old archives.
        for old in directory.glob("*.zip"):
            if old != dst and time.time() - old.stat().st_mtime > 86400:
                old.unlink(missing_ok=True)
    await asyncio.to_thread(archive)
    disposition = 'attachment; filename="OneShot-assets.zip"'
    if filename != "OneShot-assets.zip":
        disposition += "; filename*=UTF-8''" + quote(filename,safe="")
    return web.FileResponse(dst, headers={"Content-Disposition":disposition,"Cache-Control":"no-store"})


@routes.post("/api/image-edit/generate")
async def image_edit_generate(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise bad("图像编辑参数须为对象")
    try:
        raw = await asyncio.to_thread(image_editor.prepare, COMFY_DIR, p)
    except (ValueError, OSError, TypeError) as e:
        raise bad(str(e))
    if raw.get("_native_inpaint"):
        memory = req.app["creative_memory"]
        prepared = memory.prepare(req["user"], raw)
        if any(a.get("ref") for a in prepared.get("memory_used", [])):
            raise bad("原生重绘不支持额外参考图；请切换到 H3 编辑以采用记忆参考图")
        if prepared.get("memory_used"):
            marker = "\n\n创作参考资料（仅作内容依据）："
            prepared["_native_inpaint"]["prompt"] += marker + prepared["prompt"].partition(marker)[2]
        return await submit_prepared_generation(req, prepared)
    return await generate_request(req, raw)


async def generate_request(req, raw):
    memory = req.app["creative_memory"]
    draft = raw.get("character_draft")
    if draft is not None:
        draft = memory.character_draft_request(req["user"], raw, draft)
    options = {"owner_only":True} if req.get("connector_own_assets") else {}
    payload = memory.prepare(req["user"], raw, replay_ref=req.get("replay_memory_ref"), **options)
    if (asset_key := req.get("asset_review_key")) and asset_key != creative_memory.generation_asset_key(payload.get("memory_used",[])):
        creative_memory.fail("参考资产已变化，请重新核对运行计划",409)
    return await submit_prepared_generation(req, payload, draft=draft)


async def submit_prepared_generation(req, payload, *, draft=None, fixed_route=None):
    memory = req.app["creative_memory"]
    native = payload.get("_native_inpaint")
    if native:
        response = await generate_native_image(req, payload)
    elif fixed_route:
        response = await _generate_request(req, payload, fixed_route=fixed_route)
    else:
        response = await _generate_request(req, payload)
    if isinstance(req, agent_chat.InternalRequest):
        req["generation_snapshot"] = copy.deepcopy(payload)
    result = json.loads(response.body)
    route = req.get("generation_route")
    if payload.get("kind")=="video" and route:
        provider_id = route.get("provider") or "local_h3"
        result["video_model"] = {"provider":provider_id}
        if provider_id!="local_h3" and route.get("model"):
            result["video_model"]["selected_model"] = route["model"]
    references = {key:payload[key] for key in ("video_refs","audio_refs") if payload.get(key)}
    if references:
        result["reference_context"] = references
        if route and has_asset_media(payload):
            references.update(provider=route["provider"],selected_model=route["model"])
        if payload.get("camera_plan"):
            result["reference_context"]["camera_plan"] = payload["camera_plan"]
        if payload.get("object_edit"):
            result["reference_context"]["object_edit"] = payload["object_edit"]
    memory.track(req["user"], payload, result, draft)
    memory.observe(req["user"], {jid: JOBS[jid] for jid in result.get("ids", []) if jid in JOBS})
    if payload.get("memory_used"):
        result["memory_used"] = payload["memory_used"]
        if not native:
            result["memory_context"] = {k: payload[k] for k in ("prompt", "images", "planned", "memory_views") if k in payload}
    return web.json_response(result)


def requested_generation_route(raw, cap):
    provider_id = raw.get("provider")
    choice = providers.get(provider_id) if isinstance(provider_id, str) and provider_id else None
    selected = raw.get("selected_model")
    if selected is not None:
        if (not isinstance(selected, str) or not choice or not choice["enabled"] or
                choice["kind"].startswith("local_") or cap not in providers.caps_of(choice) or
                selected not in configured_models(choice, cap, providers.routes(cap))):
            raise bad("所选模型已不可用，请重新选择模型")
        return {"provider":choice, "model":selected}
    if choice and choice["enabled"] and cap in providers.caps_of(choice):
        return {"provider": choice, "model": raw.get("provider_model") or providers.default_model(choice, cap)}
    if cap=="video" and provider_id=="local_h3":
        raise bad("本地 H3 服务已不可用，请重新选择模型")
    return providers.primary(cap)


def generation_unit_cost(raw):
    """Estimated CNY per output, or None when the applicable rate is unknown."""
    kind = raw.get("kind")
    if kind == "previs":
        return 0
    if kind == "audio":
        mode = raw.get("mode")
        if not isinstance(mode, str) or mode not in AUDIO_GENERATION_MODES:
            return None
        route = next((item for item in audio_routes(mode) if not raw.get("provider") or
                      item["provider"]["id"] == raw["provider"]), None)
        return 0 if route and route["provider"]["kind"] == "local_kokoro" else None
    fields = raw.get("fields")
    prompt_parts = [raw.get("prompt"),*(fields.values() if isinstance(fields,dict) else [])]
    if kind == "video" and (raw.get("has_asset") or raw.get("memory_ids") or raw.get("memory_views") or
            any(isinstance(value,str) and "@" in re.sub(r"@(?:图|视频|音频|音)(?:\{\d{1,16}\}|\d+)", "", value)
                for value in prompt_parts)):
        return None
    if kind not in ("image", "video") or raw.get("segment_edit"):
        return None
    reference_video = any(raw.get(key) for key in ("audio_refs","video_refs","previs_guide"))
    if reference_video and kind != "video":
        return None
    try:
        if reference_video:
            route = requested_reference_routes({**raw,"previs_guide":raw.get("previs_guide") or None})[0]
        else:
            route = requested_generation_route(raw,kind)
    except web.HTTPBadRequest:
        return None
    if not route or route["provider"]["kind"] == "local_h3":
        if kind == "video" and (raw.get("draft") or raw.get("quality") in ("480p","4k")):
            return None
        return 0
    provider, model = route["provider"], route["model"]
    adapter = provider["kind"]
    if not isinstance(model, str) or (adapter, kind) not in remote.ADAPTERS:
        return None
    if kind == "image":
        return provider["config"].get("generation_rates", {}).get(f"image {model}")
    duration = raw.get("duration", 5)
    if type(duration) not in (float, int) or not 0 < duration <= 30:
        return None
    if reference_video:
        try:
            duration = reference_video_duration(raw,provider,model,{"source":"previs"} if raw.get("previs_guide") else None)
        except web.HTTPBadRequest:
            return None
    seconds = duration if reference_video else remote.video_duration(adapter,model,duration,provider=provider)
    return quoted_video_unit_cost(route,raw,seconds)


def quoted_video_unit_cost(route, raw, seconds, *, input_video_seconds=None):
    provider, model = route["provider"], route["model"]
    adapter = provider["kind"]
    rates = provider["config"].get("generation_rates", {})
    quality = raw.get("quality") or "hd"
    if raw.get("draft"):
        if not remote.supports_video_draft(provider,model):
            return None
        quality = "480p"
    options = remote.video_resolutions(adapter,model,provider=provider)
    if quality in ("480p","4k") and quality not in options:
        return None
    quality = quality if isinstance(quality,str) and quality in options else "std"
    if adapter=="minimax" and model in motion_reference.H3_CLOUD_MODELS:
        return quoted_h3_video_unit_cost(model,quality,rates,raw,seconds,input_video_seconds)
    rate = rates.get(f"video {model} {quality}")
    return round(rate * seconds,4) if rate is not None else None


def quoted_h3_video_unit_cost(model, quality, rates, raw, seconds, input_video_seconds):
    images = raw.get("images") or []
    if not isinstance(images,list) or any(not isinstance(image,dict) for image in images):
        return None
    has_video = bool(raw.get("video_refs") or raw.get("previs_guide"))
    has_av = has_video or bool(raw.get("audio_refs"))
    reference_mode = has_av or wants_image_references(raw)
    image_count = len(images)
    if reference_mode and image_count > motion_reference.image_limit(model):
        return None
    output_key = "video-ref" if reference_mode and model=="MiniMax-H3-MG" else "video"
    output = rates.get(f"{output_key} {model} {quality}")
    if output is None:
        return None
    free_images = 0 if model in ("MiniMax-H3-Max","MiniMax-H3-Max-Turbo") else 5
    billed_images = 0 if model=="MiniMax-H3-MG" else max(0,image_count-free_images)
    image_rate = rates.get(f"video-image {model} {quality}")
    video_rate = rates.get(f"video-input {model} {quality}")
    if (billed_images and image_rate is None) or (has_video and (video_rate is None or input_video_seconds is None)):
        return None
    return round(output*seconds + (image_rate or 0)*billed_images +
                 (video_rate or 0)*(input_video_seconds or 0),4)


@routes.post("/api/generation-cost")
async def generation_cost(req):
    body = await req.json()
    requests = body.get("requests") if isinstance(body, dict) else None
    if not isinstance(requests, list) or not 1 <= len(requests) <= 200 or any(
            not isinstance(item, dict) for item in requests):
        raise bad("请选择 1 到 200 个生成节点")
    amounts = []
    for item in requests:
        count = item.get("count", 1)
        if type(count) is not int or not 1 <= count <= 4:
            raise bad("生成数量无效")
        if item.get("kind") == "video":
            count = min(count, 3)
        if item.get("kind") == "video" and isinstance(item.get("board"), str):
            try:
                replay = checked_asset_replay(item)
                _, cost = await asset_reference_review(req,item,replay_ref=replay)
            except (web.HTTPException, ValueError, TypeError):
                cost = None
        else:
            cost = generation_unit_cost(item)
        amounts.append(round(cost * count, 4) if cost is not None else None)
    return web.json_response({"amounts":amounts})


async def _generate_request(req, raw, *, fixed_route=None):
    raw = apply_video_optics(raw)
    u = req["user"]
    cap = "image" if raw.get("kind") == "image" else "video"
    check_reference_operation(raw)
    retake = resolve_camera_plan(raw)
    if retake:
        raw["camera_plan"] = retake
    object_plan = resolve_object_edit(raw)
    if object_plan:
        raw["object_edit"] = object_plan
    if raw.get("previs_guide") is not None or raw.get("audio_refs") or raw.get("video_refs"):
        if raw.get("kind") != "video":
            raise bad("音视频参考仅用于视频生成")
        route, motion, clips, audio = await prepare_reference_generation(u,raw,object_plan,fixed_route=fixed_route)
        verify_reference_preview(req,raw,route)
        req["generation_route"] = {"provider":route["provider"]["id"],"model":route["model"]}
        return await generate_remote(req, raw, route, cap, motion=motion, audio_refs=audio, video_refs=clips)
    if fixed_route:
        route = None
        if provider_id := fixed_route["provider"]:
            choice = providers.get(provider_id)
            if not choice or not choice["enabled"] or cap not in providers.caps_of(choice):
                raise bad("原生成服务已不可用，请重新配置后再重试")
            route = {"provider":choice,"model":fixed_route["model"]}
    else:
        route = requested_generation_route(raw, cap)
    verify_reference_preview(req,raw,route,guide_frames=cap=="video")
    if cap=="video" or isinstance(req, agent_chat.InternalRequest):
        req["generation_route"] = {"provider":route["provider"]["id"],"model":route["model"]} if route else {"provider":None,"model":None}
    if route and route["provider"]["kind"] != "local_h3":
        return await generate_remote(req, raw, route, cap)
    if cap=="video":
        checked_video_resolution(raw,"local_h3","h3-video")
    if raw.get("draft"):
        raise bad("请选择支持原生样片的 Seedance 2.5 服务")
    p = apply_fields(raw)
    if not clean(p.get("prompt")):
        raise web.HTTPBadRequest(text=json.dumps({"error": "提示词不能为空"}), content_type="application/json")
    kind = p.get("kind")
    count = max(1, min(4, int(p.get("count") or 1)))
    llm = req.app["llm"]
    meta_extra = {}
    if kind == "image" and p.get("model", "h3img") != "h3video" and p.get("expand") and llm.available() and (TEMPLATES / "h3image_t2i.json").exists():
        edit = bool(p.get("images"))
        tpl = json.loads((TEMPLATES / ("h3image_edit.json" if edit else "h3image_t2i.json")).read_text())
        ar = float(p.get("ar") or 1)
        ar_text = "adaptive" if not p.get("ar") else f"{round(ar * 100)}:100"
        try:
            cap = await rewriter.expand_image(llm, COMFY_DIR, tpl, H3IMG_IDS[edit], re.sub(r"@图(\d+)", r"<Picture \1>", p["prompt"]), p.get("images") or [], ar_text)
        except Exception as e:
            raise web.HTTPBadRequest(text=json.dumps({"error": f"智能扩写失败：{e}"}, ensure_ascii=False), content_type="application/json")
        p = {**p, "prompt": cap, "expand": False}
        meta_extra = {"expanded": cap}
    if kind != "image" and await engine_up(req.app):
        return await generate_engine(req, p, count)     # translates in the background, after the job is queued
    if kind != "image":
        p = await to_english(req.app, p)
    if llm.running() and llm.device == "GPU":
        llm.stop()   # give the GPU back to the engine
    if kind == "image" and await engine_up(req.app, image=True):
        return await generate_engine_image(req, p, count)
    ids = []
    for _ in range(count):
        g, meta = graph_image(p) if kind == "image" else graph_video(p)
        meta["prompt"] = p["prompt"]
        cls, units, dflt = job_class(p)
        meta.update(cls=cls, units=units, est=estimate(cls, units, dflt), label=clean(p.get("label"))[:60], uid=u["id"], board=clean(p.get("board")))
        meta.update(meta_extra)
        if meta_extra:
            meta["mode_name"] = meta.get("mode_name", "") + " · 扩写"
        jid = await submit(req.app, g, meta, kind)
        attach_image_edit(JOBS[jid], p)
        ids.append(jid)
    return web.json_response({"ids": ids, "meta": JOBS[ids[0]]["meta"]})


@routes.get("/api/jobs")
async def jobs(req):
    u = req["user"]
    ids = [i for i in req.query.get("ids", "").split(",") if i and (u["role"] == "admin" or i not in JOBS
                                                                    or (JOBS[i].get("meta") or {}).get("uid") in (None, u["id"]))][:200]
    queue_order = []
    comfy_ids = [i for i in ids if not (JOBS.get(i, {}).get("out_ref") or i[:1] in "xrtp" and len(i) == 13
                                        or i.startswith("r") and len(i) == 25)]
    if any(JOBS.get(i, {}).get("state") == "queued" for i in comfy_ids):
        try:
            async with req.app["http"].get(f"{COMFY}/queue", timeout=aiohttp.ClientTimeout(total=3)) as r:
                q = await r.json()
            queue_order = [x[1] for x in q.get("queue_running", [])] + [x[1] for x in sorted(q.get("queue_pending", []), key=lambda x: x[0])]
        except Exception:
            pass
    out = {}
    for i in ids:
        j = JOBS.get(i)
        row = None
        if not j:
            row = db.one("SELECT * FROM tasks WHERE id=?", i)
            if row and u["role"] != "admin" and row["user_id"] != u["id"]:
                continue
            if row:
                j = restore_logged_job(req.app, row)
        if not j:
            # a job from before a restart: ask the history
            JOBS[i] = j = job_from_log(row) if row else {"id": i, "state": "queued", "created": time.time(), "meta": {}}
            restore_image_edit(j)
            live = set(queue_order)
            try:
                await finish(req.app, i)
                if j["state"] in ("queued", "running") and i not in live:
                    async with req.app["http"].get(f"{COMFY}/queue", timeout=aiohttp.ClientTimeout(total=3)) as r:
                        q = await r.json()
                    live = {x[1] for x in q.get("queue_running", []) + q.get("queue_pending", [])}
            except Exception:
                live = set()
            if j["state"] in ("queued", "running") and i not in live:
                j["state"] = "error"; j["error"] = "任务已不存在（服务重启过）"
        if j["state"] in ("queued", "running") and time.time() - j.get("polled", 0) > 10 and not j.get("out_ref") and i in comfy_ids:
            j["polled"] = time.time()
            try:
                await finish(req.app, i)   # in case a websocket message was missed
            except Exception:
                pass
        r = {k: j.get(k) for k in ("state", "value", "max", "node", "error", "outputs", "meta", "prep", "phase")}
        if j["state"] == "queued" and i in queue_order:
            r["ahead"] = queue_order.index(i)
            r["eta"] = round(sum(remaining(JOBS[x]) if x in JOBS else 90 for x in queue_order[:r["ahead"] + 1]))
        elif j["state"] in ("queued", "running"):
            r["eta"] = round(remaining(j))
            if j["state"] == "queued":
                r["ahead"] = j.get("ahead", 0)
        r["elapsed"] = round(time.time() - (j.get("started") or j["created"]), 1)
        out[i] = r
    req.app["creative_memory"].observe(u, out)
    return web.json_response(out)


async def cancel_engine_jobs(app, ids):
    if not ids:
        return
    try:
        async with app["http"].post(ENGINE + "/cancel", json={"ids": ids}, timeout=aiohttp.ClientTimeout(total=4)):
            pass
    except (aiohttp.ClientError, asyncio.TimeoutError):
        pass


@routes.post("/api/cancel")
async def cancel(req):
    u = req["user"]
    eng = []
    for i in (await req.json()).get("ids", []):
        if not isinstance(i, str):
            continue
        job = JOBS.get(i)
        if not job:
            row = db.one("SELECT * FROM tasks WHERE id=?", i)
            if row and (u["role"] == "admin" or row["user_id"] == u["id"]) and row["state"] in ("queued", "running"):
                job = restore_logged_job(req.app, row)
        if not job or job["state"] not in ("queued", "running"):
            continue
        if u["role"] != "admin" and (job.get("meta") or {}).get("uid") not in (None, u["id"]):
            continue
        if job.get("out_ref"):
            eng.append(job.get("eid", i))
        job.update(state="error", error="已取消", cancel=True)
        log_end(job)
    await cancel_engine_jobs(req.app, eng)
    return web.json_response({"ok": True})


@routes.post("/api/lastframe")
async def lastframe(req):
    data = await req.json()
    if not isinstance(data, dict) or not isinstance(data.get("ref"), str):
        raise bad("请选择要截帧的视频")
    ref, at = data["ref"], data.get("at")
    position = data.get("position", "last" if at is None else "time")
    if position not in ("first", "last", "time") or (position == "time") != (at is not None):
        raise bad("请选择首帧、末帧，或指定截帧时间")
    if at is not None and (type(at) not in (int, float) or not math.isfinite(at) or at < 0):
        raise bad("截帧时间无效")
    try:
        src = tools.ref_path(COMFY_DIR, ref)
    except ValueError:
        raise web.HTTPBadRequest()
    def grab():
        img, time = film.capture_frame(src, position, at)
        dst, new_ref = tools._new(COMFY_DIR, "input", "last" if position == "last" else "frame", ".png")
        img.save(dst)
        return new_ref, img.size, time

    try:
        new_ref, size, time = await asyncio.to_thread(grab)
    except (OSError, ValueError, IndexError) as e:
        raise bad(str(e)) from None
    grant_media(req["user"], new_ref)
    return web.json_response({"ref": new_ref, "url": "/media?ref=" + quote(new_ref, safe=""), "w": size[0], "h": size[1],
                              "at":time, "position":position})


@routes.get("/api/video/frame-preview")
async def video_frame_preview(req):
    ref, position = req.query.get("ref",""), req.query.get("position")
    raw_at = req.query.get("at")
    if position not in ("first","last","time") or (position=="time")!=(raw_at is not None):
        raise bad("请选择首帧、末帧，或指定截帧时间")
    try:
        at = float(raw_at) if raw_at is not None else None
    except ValueError:
        raise bad("截帧时间无效") from None
    if at is not None and (not math.isfinite(at) or at<0):
        raise bad("截帧时间无效")
    try:
        source = tools.ref_path(COMFY_DIR,ref)
    except ValueError:
        raise web.HTTPNotFound() from None
    if source.suffix.lower() not in tools.VIDEO_EXT or not source.is_file() or not can_read_media(req["user"],ref):
        raise web.HTTPNotFound()

    def preview():
        image, _ = film.capture_frame(source,position,at)
        image.thumbnail((960,960))
        buffer = io.BytesIO()
        image.save(buffer,format="PNG")
        return buffer.getvalue()

    try:
        body = await asyncio.to_thread(preview)
    except (OSError, ValueError, IndexError) as error:
        raise bad(str(error)) from None
    return web.Response(body=body,content_type="image/png",headers={"Cache-Control":"private, no-store"})


@routes.post("/api/rewrite")
async def rewrite(req):
    p = apply_fields(await req.json(), for_llm=True)
    if not clean(p.get("prompt")):
        raise web.HTTPBadRequest(text=json.dumps({"error": "先写一段描述"}, ensure_ascii=False), content_type="application/json")
    seconds = min(15.0, max(2.0, float(p.get("duration") or 5)))
    p["end"] = (frames_for(seconds) - 4) / 24 if p.get("planned") else seconds
    t0 = time.time()
    try:
        r = await rewriter.rewrite_video(req.app["llm"], COMFY_DIR, p)
    except Exception as e:
        raise web.HTTPBadRequest(text=json.dumps({"error": str(e)}, ensure_ascii=False), content_type="application/json")
    r["seconds"] = round(time.time() - t0, 1)
    return web.json_response(r)


def bad(msg):
    return web.HTTPBadRequest(text=json.dumps({"error": msg}, ensure_ascii=False), content_type="application/json")


async def llm_call(req, coro):
    """Run a Qwen tool; tell the user when it has to fall back to the (slow) CPU because a generation holds the GPU."""
    llm = req.app["llm"]
    if not llm.available():
        raise bad("本地 Qwen 模型还没装好")
    t0 = time.time()
    try:
        r = await coro
    except web.HTTPException:
        raise
    except Exception as e:
        raise bad(str(e) or e.__class__.__name__)
    r["seconds"] = round(time.time() - t0, 1)
    r["device"] = llm.via
    return web.json_response(r)


@routes.post("/api/storyboard")
async def storyboard(req):
    p = await req.json()
    if not clean(p.get("story")):
        raise bad("先写一段剧情")
    candidates = req.app["creative_memory"].storyboard_assets(req["user"],p["board"],p["story"]) if p.get("board") else []
    return await llm_call(req, tools.storyboard(req.app["llm"], COMFY_DIR, p["story"], p.get("refs") or [], p.get("shots"),
                                                p.get("seconds"), clean(p.get("style")), p.get("aspect") or "16:9", p.get("target_seconds"),
                                                **({"asset_candidates":candidates} if candidates else {})))


@routes.post("/api/describe")
async def describe(req):
    p = await req.json()
    if not p.get("images"):
        raise bad("没有图片")
    return await llm_call(req, tools.describe(req.app["llm"], COMFY_DIR, p["images"], p.get("mode") or "prompt"))


@routes.post("/api/analyze")
async def analyze(req):
    """拉片: cut the video into shots, then describe each one."""
    p = await req.json()
    try:
        cut = await asyncio.get_running_loop().run_in_executor(None, tools.find_shots, COMFY_DIR, p["ref"], int(p.get("max_shots") or 12))
    except Exception as e:
        raise bad(f"切分镜头失败：{e}")
    grant_media(req["user"], *media_references(cut))
    return await llm_call(req, tools.analyze_shots(req.app["llm"], COMFY_DIR, cut))


@routes.post("/api/video/trim")
async def trim_video(req):
    data = await req.json()
    if not isinstance(data, dict) or data.get("action") not in ("detect", "render"):
        raise bad("视频裁剪请求无效")
    points = data.get("points")
    if not isinstance(points, list) or not 2 <= len(points) <= 13 or any(type(point) is not int for point in points):
        raise bad("请选择有效的入点和出点，最多可切成 12 段")
    if any(a >= b for a, b in zip(points, points[1:])) or points[0] < 0:
        raise bad("剪辑点必须按时间顺序排列")

    def work():
        ref = data["ref"]
        path = tools.ref_path(COMFY_DIR, ref)
        duration = film.probe(path, display=False)[2]
        if points[-1] > round(duration * film.FPS):
            raise ValueError("剪辑点超出原视频范围")
        if data["action"] == "detect":
            return {"cuts":tools.video_split_points(path, points[0], points[-1], film.FPS, 12)}
        results = []
        try:
            for start, end in zip(points, points[1:]):
                clip = {"ref":ref, "in":start / film.FPS, "out":end / film.FPS, "tight":True,
                        "audio_ref":ref, "audio_start":0}
                result = film.render(COMFY_DIR, {"clips":[clip], "subtitles":False})
                result.update(start=start / film.FPS, end=end / film.FPS)
                results.append(result)
        except Exception:
            for result in results:
                tools.ref_path(COMFY_DIR, result["ref"]).unlink(missing_ok=True)
            raise
        return {"clips":results}

    try:
        async with RENDER_LOCK:
            result = await asyncio.to_thread(work)
    except (KeyError, TypeError, ValueError, OSError, IndexError) as error:
        raise bad(f"无法处理视频：{error}") from None
    for clip in result.get("clips", []):
        clip["url"] = "/media?ref=" + quote(clip["ref"], safe="")
    grant_media(req["user"], *(clip["ref"] for clip in result.get("clips", [])))
    return web.json_response(result)


@routes.post("/api/video/gif")
async def video_gif(req):
    data, options = await read_gif_request(req, fps_default=12)
    ref = data["ref"]
    start, end = data.get("start", 0), data.get("end")
    if (type(start) not in (int,float) or not 0 <= start < math.inf or
            end is not None and (type(end) not in (int,float) or not 0 < end < math.inf)):
        raise bad("GIF 区间无效")
    try:
        path = tools.ref_path(COMFY_DIR, ref)
    except ValueError:
        raise bad("找不到所选视频版本") from None
    if path.suffix.lower() not in tools.VIDEO_EXT or not path.is_file():
        raise bad("找不到所选视频版本")
    return await make_gif(req, film.export_gif, path, start=start, end=end, **options)


@routes.post("/api/image/gif")
async def image_gif(req):
    data, options = await read_gif_request(req, fps_default=8)
    rows, cols = data.get("rows"), data.get("cols")
    if any(type(value) is not int or not 1 <= value <= 6 for value in (rows,cols)):
        raise bad("宫格行列数要在 1–6 之间")
    first, last = data.get("first",1), data.get("last",rows*cols)
    if type(first) is not int or type(last) is not int or not 1 <= first < last <= rows*cols:
        raise bad("请选择至少两格连续画面")
    return await make_gif(req,film.export_grid_gif,data["ref"],rows=rows,cols=cols,first=first,last=last,**options)


async def read_gif_request(req, *, fps_default):
    try:
        data = await req.json()
    except (ValueError, UnicodeError):
        raise bad("请求格式不正确") from None
    if not isinstance(data, dict) or not isinstance(data.get("ref"), str):
        raise bad("请选择素材版本")
    fps, size, ping_pong = data.get("fps", fps_default), data.get("size", 360), data.get("ping_pong", False)
    if (type(fps) is not int or fps not in film.GIF_FPS or type(size) is not int or size not in film.GIF_SIZES or
            type(ping_pong) is not bool):
        raise bad("GIF 尺寸、帧率或循环设置无效")
    require_media(req["user"], {data["ref"]})
    return data, {"fps":fps,"size":size,"ping_pong":ping_pong}


async def make_gif(req, render_gif, source, **options):
    try:
        async with RENDER_LOCK:
            result = await asyncio.to_thread(render_gif,COMFY_DIR,source,**options)
    except ValueError as error:
        raise bad(str(error)) from None
    except (OSError, IndexError, DecompressionBombError):
        raise bad("无法读取所选素材") from None
    grant_media(req["user"], result["ref"])
    result["url"] = "/media?ref=" + quote(result["ref"], safe="")
    return web.json_response(result)


@routes.get("/api/video-remake/{board}/{node}")
@routes.post("/api/video-remake/{board}/{node}")
async def remake(req):
    return await video_remake.handle(req, sys.modules[__name__])


@routes.post("/api/split")
async def split(req):
    p = await req.json()
    rows, cols = int(p.get("rows") or 3), int(p.get("cols") or 3)
    if not (1 <= rows <= 6 and 1 <= cols <= 6):
        raise bad("宫格行列数要在 1~6 之间")
    try:
        tiles = await asyncio.get_running_loop().run_in_executor(None, tools.split_grid, COMFY_DIR, p["ref"], rows, cols)
    except Exception as e:
        raise bad(f"拆分失败：{e}")
    for t in tiles:
        t["url"] = "/media?ref=" + quote(t["ref"], safe="")
    grant_media(req["user"], *(tile["ref"] for tile in tiles))
    return web.json_response({"tiles": tiles})


@routes.post("/api/concat")
async def concat(req):
    p = await req.json()
    try:
        r = await asyncio.get_running_loop().run_in_executor(None, tools.concat, COMFY_DIR, p.get("refs") or [])
    except Exception as e:
        raise bad(f"拼接失败：{e}")
    r["url"] = "/media?ref=" + quote(r["ref"], safe="")
    grant_media(req["user"], r["ref"])
    return web.json_response(r)


LIBRARY = DATA / "library.json"


def legacy_lib_load() -> list:
    try:
        return json.loads(LIBRARY.read_text())
    except Exception:
        return []


def lib_load() -> list:
    return creative_memory.Store(sys.modules[__name__]).all()


@routes.get("/api/library")
async def library(req):
    return web.json_response(req.app["creative_memory"].list(req["user"], req.query.get("board") or None))


@routes.post("/api/library")
async def library_put(req):
    data = await req.json()
    store = req.app["creative_memory"]
    if isinstance(data, dict) and data.pop("recreate_deleted", False):
        mid = data.get("id")
        if isinstance(mid, str) and db.one("SELECT 1 FROM creative_memories WHERE id=? AND deleted=1", mid):
            data.pop("id")
            if not {"board","project","team"} & data.keys() and (bid := data.get("source_board")):
                data.update(store.default_scope(req["user"],bid))
    return web.json_response(store.put(req["user"], data))


@routes.delete("/api/library/{aid}")
async def library_del(req):
    req.app["creative_memory"].delete(req["user"], req.match_info["aid"])
    return web.json_response({"ok": True})


RENDER_LOCK = asyncio.Lock()
DEPTH_LOCK = asyncio.Lock()
STEM_LOCK = asyncio.Lock()


def film_preflight(spec, user=None, board=None):
    if not isinstance(spec, dict) or not isinstance(spec.get("clips"), list) or not spec["clips"]:
        raise ValueError("时间线上没有图片或视频")
    if spec.get("aspect", "source") not in {"source","16:9","9:16","1:1","4:3","3:4","21:9"}:
        raise ValueError("请选择支持的成片画幅")
    film.title_items(spec.get("titles", []))
    film.cutaway_items(COMFY_DIR,spec.get("cutaways", []))
    audio_clips = spec.get("audio_clips", [])
    if not isinstance(audio_clips, list):
        raise ValueError("音频片段格式无效")
    problems = []
    first_size = None
    sessions, audio_sources = {}, {}
    for i, clip in enumerate(spec["clips"]):
        try:
            _, w, h, duration, start, end = film.clip_info(COMFY_DIR, clip)
            if not 0 <= start < end <= duration + 1 / film.FPS:
                raise ValueError()
            first_size = first_size or (w, h)
        except Exception:
            problems.append({"clip":i, "error":f"第 {i + 1} 段素材无法读取，或时长超出范围"})
            continue
        try:
            film.clip_speed(clip)
            if "captions" in clip:
                film.subtitle_captions(clip["captions"])
        except ValueError as error:
            problems.append({"clip":i, "error":f"第 {i + 1} 段：{error}"})
        try:
            film.clip_source_audio(COMFY_DIR, clip, start, end, audio_sources)
        except (TypeError, ValueError, IndexError, KeyError, OSError):
            problems.append({"clip":i, "error":f"第 {i + 1} 段原片音轨无法读取，或剪辑点超出范围"})
        if provenance := clip.get("remake_shot"):
            try:
                source = provenance["source"]
                k = (provenance["node"], source)
                if k not in sessions:
                    key = video_remake.remake_key(sys.modules[__name__], user, board, *k)
                    session = video_remake.load(key)
                    video_remake.update_jobs(sys.modules[__name__], user["id"], session)
                    sessions[k] = session
                session = sessions[k]
                index, shot = next((j, s) for j, s in enumerate(session["shots"])
                                   if s["start"] == provenance["start"] and s["end"] == provenance["end"])
                review, issue = video_remake.export_choice(shot, session.get("mapping"), index)
                if issue or (review["ref"] if review else source) != clip["ref"]:
                    raise ValueError()
            except (KeyError, TypeError, ValueError, StopIteration, web.HTTPException):
                problems.append({"clip":i, "error":f"第 {i + 1} 段审核版本或剪辑点已变更，请更新这一镜"})
    for ref, label, video in [(spec.get("remake_audio"), "原声", True),
                              ((spec.get("bgm") or {}).get("ref"), "配乐", False),
                              *((a.get("ref"), f"第 {i + 1} 段旁白", False) for i, a in enumerate(spec.get("narration") or []))]:
        if not ref:
            continue
        try:
            path = tools.ref_path(COMFY_DIR, ref)
            if video:
                w, h, duration, _ = film.probe(path)
                if not 0 < duration <= 60:
                    raise ValueError()
                first_size = (w, h)
            else:
                import av
                with av.open(str(path)) as media:
                    if not media.streams.audio:
                        raise ValueError()
        except Exception:
            problems.append({"error":f"{label}文件无法读取"})
    for i, clip in enumerate(audio_clips):
        try:
            film.audio_clip_info(COMFY_DIR, clip)
        except (TypeError, ValueError, IndexError, KeyError, OSError):
            problems.append({"audio":i, "error":f"第 {i + 1} 段音频无法读取，或入点、出点和音量超出范围"})
            continue
        if "captions" in clip:
            try:
                film.subtitle_captions(clip["captions"])
            except ValueError as error:
                problems.append({"audio":i, "error":f"第 {i + 1} 段音频的旁白字幕无效：{error}"})
    dimensions = film.target_size(*first_size, spec.get("aspect") or "source") if first_size else None
    return {"ok":not problems, "issues":problems, "dimensions":dimensions}


@routes.post("/api/render/check")
async def render_check(req):
    data = await req.json()
    try:
        result = await asyncio.to_thread(film_preflight, data.get("spec"), req["user"], data.get("board"))
    except (AttributeError, TypeError, ValueError) as e:
        raise bad(str(e))
    return web.json_response(result)


@routes.post("/api/render")
async def render_film(req):
    """成片: render a timeline in the background; it is tracked like a generation job (poll /api/jobs)."""
    p = await req.json()
    spec = p.get("spec") or {}
    attempt = p.get("request_key")
    target = p.get("target")
    if target is not None:
        if not isinstance(target,dict) or not isinstance(target.get("node"),str):
            raise bad("请选择要保存新版本的视频")
        if not attempt:
            raise bad("保存为新版本需要导出请求编号")
        field = "playlist_revision" if "playlist_revision" in target else "ref"
        if not isinstance(target.get(field),str) or field == "playlist_revision" and not re.fullmatch(r"[a-f0-9]{64}",target[field]):
            raise bad("请选择要保存新版本的视频")
        target = {k:target[k] for k in ("node",field)}
    if not attempt:
        return enqueue_film(req, spec, label=p.get("label"))
    if not isinstance(attempt, str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}", attempt):
        raise bad("导出请求编号无效")
    uid = req["user"]["id"]
    jid = "r" + hashlib.sha256(f"{uid}:{attempt}".encode()).hexdigest()[:24]
    fingerprint = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    try:
        check = await asyncio.to_thread(film_preflight, spec, req["user"], p.get("board"))
    except (AttributeError, TypeError, ValueError) as e:
        raise bad(str(e))
    prior = db.one("SELECT state,request FROM tasks WHERE id=? AND user_id=?", jid, uid)
    if prior:
        saved = json.loads(prior["request"])
        if saved["fingerprint"] != fingerprint or ("target" in saved and saved["target"] != target):
            raise bad("导出内容已变更，请重新检查后提交")
        return web.json_response({"ids":[jid],"meta":JOBS.get(jid, {}).get("meta") or {"est":0}})
    if not check["ok"]:
        raise bad(check["issues"][0]["error"])
    request_data = {"fingerprint":fingerprint}
    if target is not None:
        board = board_meta(board_path(p.get("board")))
        if not board or not can_edit(req["user"],board):
            raise web.HTTPForbidden()
        node = next((n for n in board.get("nodes",[]) if n.get("id")==target["node"] and n.get("type")=="video"),None)
        if "playlist_revision" in target:
            data = node.get("data",{}) if node else {}
            if not data.get("playlist") or film.playlist_revision(data.get("film")) != target["playlist_revision"]:
                return auth.err(409,"播放列表已变化，请重新打开后导出")
        elif not node or not any(v.get("ref")==target["ref"] for v in node.get("versions",[])):
            return auth.err(409,"剪辑所用的视频版本已移除")
        if node.get("job"):
            return auth.err(409,"节点正在处理另一个任务，请稍候")
        request_data["target"] = target
    return enqueue_film(req, spec, label=p.get("label"), board=p.get("board"), jid=jid, request_data=request_data)


def enqueue_film(req, spec, *, label=None, source_audio=None, board=None, display=True, jid=None, request_data=None):
    clips = [c for c in spec.get("clips") or [] if c.get("ref")]
    if not clips:
        raise bad("时间线上没有图片或视频")
    try:
        secs = sum(image_editor.number(c.get("duration"), .5, 60, "图片停留时长", 3) if c.get("kind") == "image"
                   else max(.5, float(c.get("out") or 8) - float(c.get("in") or 0)) / film.clip_speed(c) for c in clips)
    except (TypeError, ValueError) as error:
        raise bad(str(error)) from None
    def render_timeline(progress, cancelled):
        return film.render(COMFY_DIR, spec, progress, cancelled, source_audio=source_audio, display=display)
    return enqueue_render(req, render_timeline, seconds=secs, label=label, board=board, jid=jid, request_data=request_data)


async def broll_source(user, payload):
    if not isinstance(payload,dict) or not isinstance(payload.get("board"),str):
        raise ValueError("请选择来源画布和素材")
    board_id = payload["board"]
    board = board_meta(board_path(board_id))
    if not board or not can_edit(user,board):
        raise web.HTTPForbidden()
    node = next((node for node in board.get("nodes",[]) if node.get("id")==payload.get("node")),None)
    if not node or node.get("type") not in ("image","video"):
        raise ValueError("请选择一张图片或一段视频")
    ref = payload.get("ref")
    if not isinstance(ref,str) or not any(version.get("ref")==ref for version in node.get("versions",[])):
        raise ValueError("所选素材版本已移除")
    require_media(user,{ref})
    path = tools.ref_path(COMFY_DIR,ref)
    kind = node["type"]
    extensions = creative_memory.IMAGE_EXT if kind == "image" else tools.VIDEO_EXT
    if not path.is_file() or path.suffix.lower() not in extensions:
        raise ValueError("所选素材文件不可用")
    try:
        duration = (await asyncio.to_thread(film.probe,path))[2] if kind == "video" else None
    except Exception as error:
        raise ValueError("无法读取来源视频") from error
    return board_id,node,ref,duration


@routes.post("/api/broll/draft")
async def draft_broll(req):
    payload = await req.json()
    try:
        _, node, _, duration = await broll_source(req["user"],payload)
        mode = payload.get("mode")
        if not isinstance(mode,str) or mode not in broll.MODES or mode == "motion" and node["type"] != "image":
            raise ValueError("请选择可用的 B-roll 类型")
        brief = broll.text(payload.get("brief"),1000,"画面说明")
        options = {key:payload[key] for key in ("start","end","duration","style") if key in payload}
    except (TypeError,ValueError) as error:
        raise bad(str(error)) from None
    guide = {"title":"{\"title\":\"短标题\"}","captions":"{\"lines\":[\"第一行\",\"第二行\"]}",
             "chart":"{\"title\":\"标题\",\"bars\":[{\"label\":\"名称\",\"value\":1}]}","motion":"{\"direction\":\"in 或 out\"}"}[mode]
    system = "你为视频制定动态图形草稿。只输出 JSON，保留用户明确给出的文字和数字。字幕卡为1–6行。条形图需2–6项，只采用用户已给出的非负数值，材料不足时返回空 bars。不要虚构统计数据。输出格式 " + guide
    try:
        reply = await req.app["llm"].chat(system, brief, max_tokens=650, temperature=.2)
        draft = tools.parse_json(reply)
    except Exception:
        return auth.err(503,"无法使用当前文本模型起草，可在控制台检查配置，或手动填写")
    try:
        if not isinstance(draft,dict):
            raise ValueError("文本模型未返回可用草稿")
        result = broll.recipe({**draft,**options,"mode":mode},node["type"],duration)
    except (TypeError,ValueError) as error:
        raise bad(str(error)) from None
    return web.json_response(result)


@routes.post("/api/broll/render")
async def render_broll(req):
    payload = await req.json()
    try:
        board_id,node,ref,duration = await broll_source(req["user"],payload)
        graphics = broll.recipe(payload.get("recipe"),node["type"],duration)
        attempt = payload.get("request_key")
        if not isinstance(attempt,str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}",attempt):
            raise ValueError("B-roll 请求编号无效")
    except (TypeError,ValueError) as error:
        raise bad(str(error)) from None
    kind = node["type"]
    duration = duration if kind == "video" else graphics["duration"]
    clip = {"ref":ref,"kind":kind,"tight":True,"out":duration} if kind == "video" else {"ref":ref,"kind":kind,"duration":duration}
    spec = {"clips":[clip],"aspect":"source","fit":"crop","subtitles":False,"broll":graphics,"cover":0}
    fingerprint = hashlib.sha256(json.dumps([board_id,node["id"],spec],sort_keys=True).encode()).hexdigest()
    uid = req["user"]["id"]
    jid = "broll" + hashlib.sha256(f"{uid}:{attempt}".encode()).hexdigest()[:20]
    prior = db.one("SELECT request FROM tasks WHERE id=? AND user_id=?",jid,uid)
    if prior:
        if task_settings(prior["request"]).get("fingerprint") != fingerprint:
            return auth.err(409,"B-roll 内容已变更，请重新提交")
        return web.json_response({"ids":[jid],"meta":JOBS.get(jid,{}).get("meta",{}),"recipe":graphics})

    def render_graphics(progress,cancelled):
        return film.render(COMFY_DIR,spec,progress,cancelled,max_side=1920 if kind == "image" else None)

    response = enqueue_render(req,render_graphics,seconds=duration,label=node.get("name"),board=board_id,jid=jid,
                              request_data={"fingerprint":fingerprint,"broll":graphics,"source":ref},mode="B-roll")
    return web.json_response({**json.loads(response.body),"recipe":graphics})


def enqueue_render(req, render_clip, *, seconds, label=None, board=None, jid=None, request_data=None, depth=False, mode=None):
    jid = jid or "r" + uuid.uuid4().hex[:12]
    mode = mode or ("深度参考" if depth else "成片")
    j = JOBS[jid] = {"id": jid, "kind": "render", "state": "queued", "created": time.time(),
                     "meta": {"label": clean(label)[:60] or mode, "est": round(3 + seconds * (20 if depth else FPS_EST), 1),
                              "cls": "depth" if depth else "render", "units": seconds,
                              "uid": req["user"]["id"], "board": board, "mode_name": mode}}
    db.task_start(id=jid, user_id=req["user"]["id"], board_id=board, capability="render",
                  label=j["meta"]["label"], request=request_data)

    async def run():
        async with (DEPTH_LOCK if depth else RENDER_LOCK):
            if j.get("cancel"):
                j.update(state="error", error="已取消")
                log_end(j)
                return
            j["state"] = "running"; j["started"] = time.time()
            db.task_update(jid, state="running", started=j["started"])

            def prog(a, b):
                j["value"], j["max"] = a, b
            try:
                r = await asyncio.to_thread(render_clip, prog, lambda: j.get("cancel"))
            except film.Cancelled:
                j.update(state="error", error="已取消")
                log_end(j)
                return
            except Exception as e:
                if not j.get("cancel"):
                    action = "合成" if mode == "成片" else mode
                    j.update(state="error", error=f"{action}失败：{e}"[:500])
                log_end(j)
                return
            if j.get("cancel"):
                return
            grant_media(req["user"], r.get("cover"))
            extra = {"cover": r.get("cover"), "cover_url": "/media?ref=" + quote(r["cover"], safe="") if r.get("cover") else None}
            j["outputs"] = [{"ref": r["ref"], "url": "/media?ref=" + quote(r["ref"], safe=""),
                             "meta": {"width": r["w"], "height": r["h"], "duration": r["seconds"]}, "extra": extra}]
            j["finished"] = time.time(); j["state"] = "done"
            log_end(j)
            record(j)
    asyncio.create_task(run())
    return web.json_response({"ids": [jid], "meta": j["meta"]})


@routes.post("/api/previs/camera-motion")
async def previs_camera_motion(req):
    return await previs_motion_plan(req,previs.camera_motion,"camera")


@routes.post("/api/previs/object-motion")
async def previs_object_motion(req):
    return await previs_motion_plan(req,previs.object_motion,"keys")


async def previs_motion_plan(req, motion, result_name):
    try:
        data = await req.json()
        if not isinstance(data,dict):
            raise ValueError("请选择白模场景及运镜设置")
        scene = previs.validate(data.get("scene"))
        track = motion(scene,data.get("plan"))
    except (ValueError,UnicodeError) as error:
        raise bad(str(error)) from None
    return web.json_response({result_name:track})


@routes.post("/api/previs/render")
async def render_previs(req):
    payload = await req.json()
    if not isinstance(payload, dict):
        raise bad("白模请求格式不正确")
    bid, nid, attempt = (payload.get(key) for key in ("board","node","request_key"))
    if not isinstance(nid, str) or not _ID.fullmatch(nid) or not isinstance(attempt, str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}", attempt):
        raise bad("节点或请求编号无效")
    board = board_meta(board_path(bid))
    user = req["user"]
    if not board or not can_edit(user, board):
        return auth.err(404, "画布不存在或没有编辑权限")
    node = next((n for n in board.get("nodes", []) if n.get("id") == nid and n.get("type") == "video"), None)
    if not node or not isinstance(node.get("data", {}).get("previs"), dict):
        return auth.err(404, "白模节点已不存在")
    try:
        scene = previs.validate(node["data"]["previs"])
        span = payload.get("span")
        start, end = previs.render_span(scene,span)
    except ValueError as exc:
        raise bad(str(exc))
    render_input = scene if span is None else {"scene":scene,"span":[start,end]}
    fingerprint = hashlib.sha256(json.dumps(render_input, sort_keys=True).encode()).hexdigest()
    jid = "r" + hashlib.sha256(f"previs:{user['id']}:{bid}:{nid}:{attempt}".encode()).hexdigest()[:12]
    if prior := db.one("SELECT request FROM tasks WHERE id=? AND user_id=?", jid, user["id"]):
        if json.loads(prior["request"] or "{}").get("fingerprint") != fingerprint:
            return auth.err(409, "白模已变更，请重新提交")
        return web.json_response({"ids":[jid]})
    if payload.get("revision") != board.get("rev"):
        return auth.err(409, "画布已变更，请保存后重试")
    if any(j["state"] in ("queued","running") and (m := j.get("meta", {})).get("board") == bid and
           m.get("previs_node") == nid for j in JOBS.values()):
        return auth.err(409, "这个白模正在渲染")

    def encode(progress, cancelled):
        return previs.export(COMFY_DIR, scene, progress, cancelled, span=(start,end))

    label = "白模预演" if span is None else "白模分镜"
    response = enqueue_render(req, encode, seconds=(end-start)/film.FPS, label=label+" · "+clean(node.get("name")),
                              board=bid, jid=jid, request_data={"fingerprint":fingerprint}, mode=label+"渲染")
    JOBS[jid]["meta"]["previs_node"] = nid
    return response


FPS_EST = 0.45   # render seconds per second of film (768p, measured); refined by the stats


@routes.post("/api/cover")
async def cover(req):
    p = await req.json()
    try:
        r = await asyncio.get_running_loop().run_in_executor(None, film.cover_frame, COMFY_DIR, p["ref"], float(p.get("at") or 0))
    except Exception as e:
        raise bad(f"取封面失败：{e}")
    r["url"] = "/media?ref=" + quote(r["ref"], safe="")
    grant_media(req["user"], r["ref"])
    return web.json_response(r)


ASR_AUDIO_LIMIT = 8 * 1024 * 1024
ASR_AUDIO_TYPES = {
    ".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg", ".mp4": "audio/mp4",
    ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".flac": "audio/flac",
}


def is_transcription_audio(header, extension):
    if extension == ".wav":
        return header[:4] == b"RIFF" and header[8:12] == b"WAVE"
    if extension in (".m4a", ".mp4"):
        return header[4:8] == b"ftyp"
    if extension == ".mp3":
        return header.startswith(b"ID3") or (len(header) >= 2 and header[0] == 255 and header[1] & 224 == 224)
    return header.startswith({".webm": b"\x1aE\xdf\xa3", ".ogg": b"OggS", ".flac": b"fLaC"}[extension])


@routes.get("/api/transcription")
async def transcription_status(_):
    return web.json_response({"available": bool(providers.routes("asr"))})


@routes.post("/api/transcription")
async def transcribe_audio(req):
    configured = providers.routes("asr")
    if not configured:
        return auth.err(503, "请在控制台配置语音转写服务")
    if req.content_type != "multipart/form-data":
        raise bad("请选择音频文件")
    try:
        part = await (await req.multipart()).next()
        if part is None or part.name != "file" or not part.filename:
            raise bad("请选择音频文件")
        extension = Path(part.filename).suffix.lower()
        content_type = ASR_AUDIO_TYPES.get(extension)
        if content_type is None:
            raise bad("不支持的音频格式")
        audio = bytearray()
        while chunk := await part.read_chunk(64 * 1024):
            audio.extend(chunk)
            if len(audio) > ASR_AUDIO_LIMIT:
                return auth.err(413, "音频文件不能超过 8 MB")
    except (ValueError, AssertionError):
        raise bad("无法读取上传的音频")
    if not is_transcription_audio(audio, extension):
        raise bad("音频内容与文件格式不符")
    recording = bytes(audio)
    if req.query.get("preview") == "1":
        try:
            recording = await asyncio.to_thread(film.recording_preview_wav, recording)
        except ValueError as error:
            raise bad(str(error)) from None
        extension, content_type = ".wav", "audio/wav"
    transcript = await plain_transcript(req, configured, recording, extension, content_type)
    if transcript is not None:
        return web.json_response({"text": transcript})
    return auth.err(502, "语音转写服务暂时不可用，请稍后重试")


async def plain_transcript(req, configured, audio, extension, content_type):
    for route in configured:
        try:
            return await providers.transcribe(req.app["http"], route["provider"], route["model"],
                                              audio, extension, content_type)
        except providers.ProviderError:
            continue


def audio_node_source(req, payload):
    if not isinstance(payload, dict) or not all(isinstance(payload.get(k), str) for k in ("board", "node", "ref")):
        raise bad("请选择画布上的音频版本")
    board = board_meta(board_path(payload["board"]))
    if not board or not can_edit(req["user"], board):
        raise web.HTTPForbidden()
    source = next((n for n in board.get("nodes", []) if n["id"] == payload["node"] and n["type"] == "audio"), None)
    if not source or not any(v.get("ref") == payload["ref"] for v in source.get("versions", [])):
        raise bad("音频版本已移除，请重新选择")
    require_media(req["user"], {payload["ref"]})
    return payload["ref"]


def stem_source(user, bid, nid, ref):
    if not all(isinstance(value,str) for value in (bid,nid,ref)):
        raise bad("请选择画布上的视频或音频版本")
    board = board_meta(board_path(bid))
    if not board or not can_edit(user,board):
        raise web.HTTPForbidden()
    source = next((n for n in board.get("nodes",[]) if n["id"] == nid and n["type"] in ("audio","video")),None)
    if not source or not any(v.get("ref") == ref for v in source.get("versions",[])):
        raise bad("原素材版本已移除，请重新选择")
    require_media(user,{ref})
    return source


@routes.get("/api/audio/waveform")
async def get_audio_waveform(req):
    ref = req.query.get("ref","")
    try:
        source = tools.ref_path(COMFY_DIR,ref)
    except ValueError:
        raise web.HTTPNotFound() from None
    if source.suffix.lower() not in AUDIO_MEDIA_EXT or not source.is_file() or not can_read_media(req["user"],ref):
        raise web.HTTPNotFound()
    try:
        result = await asyncio.to_thread(audio_waveform.waveform,source)
    except (OSError,ValueError,TypeError) as error:
        raise bad("暂时无法读取此音频的波形") from error
    return web.json_response(result,headers={"Cache-Control":"private, no-cache"})


@routes.get("/api/audio/separate")
async def latest_stems(req):
    user = req["user"]
    bid, nid, ref = (req.query.get(key) for key in ("board","node","ref"))
    stem_source(user,bid,nid,ref)
    last = db.one("""SELECT id,request FROM tasks WHERE user_id=? AND board_id=? AND capability='audio_separation'
                     AND json_extract(request,'$.node')=? AND json_extract(request,'$.ref')=?
                     ORDER BY created DESC LIMIT 1""",user["id"],bid,nid,ref)
    return web.json_response({"available":bool(audio_separation.executable()),
        "latest":{"id":last["id"],"range":json.loads(last["request"])["range"]} if last else None})


@routes.post("/api/audio/separate")
async def request_stems(req):
    payload = await req.json()
    if not isinstance(payload,dict):
        raise bad("请选择画布上的视频或音频版本")
    user = req["user"]
    bid, nid, ref, attempt = (payload.get(key) for key in ("board","node","ref","request_key"))
    source = stem_source(user,bid,nid,ref)
    if not isinstance(attempt,str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}",attempt):
        raise bad("音轨分离请求编号无效")
    try:
        requested = audio_separation.range_values(payload)
        path = tools.ref_path(COMFY_DIR,ref)
        start, end = await asyncio.to_thread(audio_separation.media_range,path,source["type"],*requested)
    except (ValueError,OSError,OverflowError) as error:
        raise bad(str(error)) from None
    source = stem_source(user,bid,nid,ref)
    jid = "t" + hashlib.sha256(json.dumps(["stems",user["id"],bid,nid,ref,attempt]).encode()).hexdigest()[:12]
    interval = {"start":start / film.SR,"end":end / film.SR}
    receipt = {"node":nid,"ref":ref,"range":interval}
    if prior := db.one("SELECT request FROM tasks WHERE id=? AND user_id=?",jid,user["id"]):
        if json.loads(prior["request"]) != receipt:
            return auth.err(409,"分离区间已变更，请重新提交")
        return web.json_response({"id":jid,"range":interval})
    for job in JOBS.values():
        if job["state"] not in ("running","queued") or job.get("mode") != "audio_separation":
            continue
        if (job["meta"]["uid"],job["meta"]["board"],job["meta"]["node"],job["meta"]["ref"]) == (user["id"],bid,nid,ref):
            if job["meta"]["range"] == interval:
                return web.json_response({"id":job["id"],"range":interval})
            return auth.err(409,"此版本已有分离任务，请等待完成或取消后再切换区间")
    binary = audio_separation.executable()
    if not binary:
        return auth.err(503,"部署主机尚未配置人声分离模型")
    mode = "人声分离"
    label = clean(source.get("name"))[:50] or mode
    meta = {"uid":user["id"],"board":bid,"node":nid,"ref":ref,"range":interval,
            "label":label,"mode_name":mode}
    job = {"id":jid,"kind":"audio","mode":"audio_separation","state":"queued","created":time.time(),"meta":meta}
    db.task_start(id=jid,user_id=user["id"],board_id=bid,label=label,capability="audio_separation",
                  provider_id="local_demucs",provider_kind="local_demucs",model=audio_separation.MODEL,request=receipt)
    JOBS[jid] = job
    asyncio.create_task(run_stems(job,binary,path,source["type"],start,end))
    return web.json_response({"id":jid,"range":interval})


async def run_stems(job, binary, path, kind, start, end):
    async with STEM_LOCK:
        if job.get("cancel"):
            return
        jid = job["id"]
        job.update(state="running",started=time.time())
        db.task_update(jid,state="running",started=job["started"])
        try:
            def phase(value):
                job["phase"] = value
            refs = await audio_separation.separate(COMFY_DIR,binary,path,kind,start,end,phase,lambda:job.get("cancel"))
            if job.get("cancel"):
                for ref in refs.values():
                    tools.ref_path(COMFY_DIR,ref).unlink(missing_ok=True)
                return
            duration = (end-start) / film.SR
            outputs = [{"ref":refs[stem],"url":"/media?ref="+quote(refs[stem],safe=""),
                        "meta":{"duration":duration},"extra":{"stem":stem}} for stem in audio_separation.STEMS]
            job.update(state="done",phase="done",outputs=outputs,finished=time.time())
        except film.Cancelled:
            job.update(state="error",error="已取消")
        except Exception as error:
            if not job.get("cancel"):
                detail = str(error) if isinstance(error,ValueError) else "无法读取音频或运行分离模型"
                job.update(state="error",error=detail[:300])
        finally:
            log_end(job)


@routes.post("/api/audio/cut")
async def audio_cut(req):
    payload = await req.json()
    ref = audio_node_source(req,payload)
    entries = payload.get("ranges")
    if not isinstance(entries,list) or not 1 <= len(entries) <= film.CAPTION_LIMIT:
        raise bad("请至少选择一段要保留的音频")
    ranges = []
    previous = 0
    for entry in entries:
        start, end = (entry.get("start"),entry.get("end")) if isinstance(entry,dict) else (None,None)
        if type(start) not in (int,float) or type(end) not in (int,float) or not 0 <= previous <= start < end <= 86400:
            raise bad("音频区间须按时间顺序排列，且不能重叠")
        ranges.append((float(start),float(end)))
        previous = end
    if ranges[-1][1] - ranges[0][0] > 90.001:
        raise bad("每次最多剪辑 90 秒的转写区间")
    key = hashlib.sha256(json.dumps([req["user"]["id"],ref,ranges]).encode()).hexdigest()[:24]
    target = f"output:h3studio/audio_cut_{key}.wav"
    try:
        async with RENDER_LOCK:
            result = await asyncio.to_thread(film.cut_audio_ranges,COMFY_DIR,ref,ranges,target)
    except (KeyError,TypeError,ValueError,OSError,OverflowError) as error:
        raise bad("无法剪辑音频：" + str(error)) from None
    grant_media(req["user"], target)
    result["url"] = "/media?ref=" + quote(target,safe="")
    return web.json_response(result)


@routes.post("/api/audio/transcript")
async def audio_transcript(req):
    payload = await req.json()
    audio_node_source(req,payload)
    configured = providers.routes("asr")
    if not configured:
        return auth.err(503, "请在控制台配置语音转写服务")
    clip = {k:payload[k] for k in ("ref", "in", "out") if k in payload}
    try:
        wav, start, end = await asyncio.to_thread(film.transcription_wav, COMFY_DIR, clip, audio_only=True)
    except (KeyError, TypeError, ValueError, OSError, OverflowError) as error:
        raise bad("无法读取音频：" + str(error)) from None
    captions = await timed_transcript(req, configured, wav, start, end)
    text = "\n".join(cue["text"] for cue in captions) if captions is not None else (
        await plain_transcript(req, configured, wav, ".wav", "audio/wav"))
    if text is None:
        return auth.err(502, "语音转写服务暂时不可用，请稍后重试")
    return web.json_response({"text":text,"captions":captions or [],"start":start,"end":end})


@routes.post("/api/video/captions")
async def video_captions(req):
    raw = await req.json()
    if not isinstance(raw, dict) or not isinstance(raw.get("ref"), str):
        raise bad("请选择要识别字幕的视频片段")
    board = board_meta(board_path(raw.get("board")))
    if not board or not can_edit(req["user"], board):
        raise web.HTTPForbidden()
    configured = providers.routes("asr")
    if not configured:
        return auth.err(503, "请在控制台配置语音转写服务")
    clip = {k:raw[k] for k in ("ref", "in", "out", "audio_ref", "audio_start") if k in raw}
    clip["kind"] = "video"
    try:
        wav, start, end = await asyncio.to_thread(film.transcription_wav, COMFY_DIR, clip)
    except (KeyError, TypeError, ValueError, OSError, OverflowError) as error:
        raise bad("无法提取视频原声：" + str(error)) from None
    captions = await timed_transcript(req, configured, wav, start, end)
    if captions is not None:
        return web.json_response({"captions":captions})
    return auth.err(502, "转写服务暂时不可用，或不支持返回字幕时间码")


async def timed_transcript(req, configured, wav, start, end):
    for route in configured:
        try:
            segments = await providers.transcribe(req.app["http"], route["provider"], route["model"],
                                                   wav, ".wav", "audio/wav", timed=True)
        except providers.ProviderError:
            continue
        captions = []
        for segment in segments[:film.CAPTION_LIMIT]:
            if not isinstance(segment, dict):
                continue
            a, b, caption = (segment.get(key) for key in ("start", "end", "text"))
            if (type(a) not in (int,float) or type(b) not in (int,float) or not -math.inf < a < b < math.inf or
                    not isinstance(caption, str) or not caption.strip()):
                continue
            captions.append({"start":round(max(start,start+a),3), "end":round(min(end,start+b),3), "text":caption.strip()[:500]})
        timed = []
        for cue in sorted(captions, key=lambda item: item["start"]):
            if timed:
                cue["start"] = max(cue["start"], timed[-1]["end"])
            if cue["end"] > cue["start"]:
                timed.append(cue)
        if timed or not segments:
            return timed


@routes.post("/api/upload_audio")
async def upload_audio(req):
    reader = await req.multipart()
    part = await reader.next()
    if part is None or not part.filename:
        raise bad("请选择音频文件")
    raw = await part.read(decode=False)
    ext = os.path.splitext(part.filename or "x.mp3")[1].lower() or ".mp3"
    if ext not in (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".mov", ".webm"):
        raise bad("不支持的音频格式")
    name = f"music_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{ext}"
    dst = COMFY_DIR / "input" / "h3studio" / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(raw)

    def dur():
        import numpy as np
        a = film.read_audio(dst)
        if not a.shape[1] or float(np.abs(a).max()) == 0:
            raise ValueError("文件里没有声音")
        return round(a.shape[1] / film.SR, 2)
    try:
        secs = await asyncio.get_running_loop().run_in_executor(None, dur)
    except Exception as e:
        dst.unlink(missing_ok=True)
        raise bad(f"读不了这个音频：{e}")
    ref = f"input:h3studio/{name}"
    grant_media(req["user"], ref)
    return web.json_response({"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "seconds": secs, "name": part.filename or name})


@routes.get("/api/voices")
async def voices(_):
    vs = list(tts.VOICES) if tts.available() else []
    route = providers.primary("tts")
    if route and route["provider"]["kind"] == "minimax":
        vs = [{"id": v, "name": f"{n}（MiniMax）"} for v, n in remote.MM_VOICES] + vs
    return web.json_response({"available": bool(vs), "voices": vs})


@routes.post("/api/tts")
async def tts_say(req):
    """旁白: Kokoro-82M (Chinese) on the CPU, so it never waits for the GPU."""
    p = await req.json()
    route = providers.primary("tts")
    if route and route["provider"]["kind"] != "local_kokoro" and not str(p.get("voice") or "").startswith(("zf_", "zm_")):
        return await tts_remote(req, p, route)
    if not tts.available():
        raise bad("配音模型还没装好")
    text = clean(p.get("text"))
    if not text:
        raise bad("先写旁白文字")
    t0 = time.time()
    try:
        r = await tts.say(COMFY_DIR, text, p.get("voice") or "zf_xiaoxiao", float(p.get("speed") or 1.0))
    except Exception as e:
        raise bad(f"配音失败：{e}")
    r["url"] = "/media?ref=" + quote(r["ref"], safe="")
    r["took"] = round(time.time() - t0, 1)
    grant_media(req["user"], r["ref"])
    return web.json_response(r)


def audio_routes(cap):
    routes = {}
    for route in providers.routes(cap):
        routes.setdefault(route["provider"]["id"],route)
    for provider in providers.all_providers():
        if provider["enabled"] and cap in providers.caps_of(provider):
            routes.setdefault(provider["id"], {"provider":provider,"model":providers.default_model(provider, cap)})
    result = []
    for route in routes.values():
        p = route["provider"]
        if p["kind"] == "local_kokoro":
            if cap == "tts" and tts.available():
                result.append({**route, "voices":tts.VOICES})
        elif (p["kind"], cap) in remote.ADAPTERS and p.get("secrets", {}).get("api_key"):
            if p["kind"] == "elevenlabs" and cap == "tts":
                voices = providers.elevenlabs_voices(p["config"].get("voices", ""))
                if not voices:
                    continue
                speed = [1,1] if route["model"] == "eleven_v3" else [.7,1.2]
                result.append({**route,"voices":voices,"speed_range":speed,"subtitles":True})
            elif cap == "seed_audio":
                result.append({**route,"voices":[],"subtitles":True})
            else:
                voices = [{"id":v,"name":name} for v,name in remote.MM_VOICES] if cap == "tts" else []
                result.append({**route, "voices":voices})
    return result


def audio_service_options(cap):
    return [{"id":r["provider"]["id"],"name":r["provider"]["name"],"model":r["model"],"voices":r["voices"],
             **{key:r[key] for key in ("speed_range","subtitles") if key in r}} for r in audio_routes(cap)]


def seed_audio_bindings(board, user, raw, target_id):
    if not isinstance(raw,list) or len(raw)>3:
        raise bad("请选择最多 3 段参考音频或 1 张参考图")
    assets, kinds = [], set()
    nodes = {n["id"]:n for n in board.get("nodes",[])}
    seen = set()
    for item in raw:
        if not isinstance(item,dict) or not all(isinstance(item.get(k),str) for k in ("node_id","ref")):
            raise bad("参考素材格式无效")
        ident, ref = item["node_id"], item["ref"]
        source = nodes.get(ident)
        if (not source or ident==target_id or source.get("type") not in ("audio","image") or
                not any(v.get("ref")==ref for v in source.get("versions",[])) or ref in seen):
            raise bad("参考素材已移除、重复或不是画布上的可用版本")
        kind = source["type"]
        seen.add(ref)
        kinds.add(kind)
        assets.append({"node_id":ident,"ref":ref,"kind":kind})
    if len(kinds)>1 or kinds=={"image"} and len(assets)>1:
        raise bad("参考音频和参考图不能混用，最多选择 1 张图")
    require_media(user,seen)
    return assets


def seed_audio_reference_bytes(entries):
    resolved = []
    for entry in entries:
        kind, ref = entry["kind"], entry["ref"]
        path = tools.ref_path(COMFY_DIR,ref)
        if not path.is_file() or path.stat().st_size>10_000_000:
            raise ValueError("参考素材不存在或超过 10 MB")
        ext = path.suffix.lower()
        if kind == "image":
            if ext not in (".jpg",".jpeg",".png",".webp"):
                raise ValueError("参考图片须为 JPEG、PNG 或 WebP")
            data = path.read_bytes()
        else:
            if ext not in tools.AUDIO_EXT or film.audio_duration(path)>30.001:
                raise ValueError("单段参考音频须在 30 秒以内")
            if ext in (".wav",".mp3"):
                data = path.read_bytes()
            else:
                data, _, _ = film.transcription_wav(COMFY_DIR,{"ref":ref},audio_only=True)
        if not data or len(data)>10_000_000:
            raise ValueError("参考素材为空或超过 10 MB")
        resolved.append({"kind":kind,"data":data})
    return resolved


def seed_audio_prompt(text, references):
    count = sum(x["kind"]=="audio" for x in references)
    tokens = {int(m) for m in re.findall(r"@音频(\d{1,4})(?!\d)",text)}
    if any(i<1 or i>count for i in tokens):
        raise bad("提示词引用了不存在的参考音频")
    missing = [f"@音频{i}" for i in range(1,count+1) if i not in tokens]
    effective = text + ("\n声音参考：" + "、".join(missing) if missing else "")
    if len(effective)>3000:
        raise bad("提示词加参考编号后不能超过 3000 字")
    return effective


@routes.post("/api/audio/generate")
async def generate_audio(req):
    raw = await req.json()
    if not isinstance(raw, dict) or not isinstance(raw.get("mode"),str) or raw["mode"] not in AUDIO_GENERATION_MODES:
        raise bad("请选择配音、音乐或音效")
    cap, bid, nid, attempt = (raw.get(k) for k in ("mode","board","node","request_key"))
    board = board_meta(board_path(bid))
    user = req["user"]
    if not board or not can_edit(user, board):
        return auth.err(403, "需要画布编辑权限")
    if nid is not None and not any(n.get("id") == nid and n.get("type") == "audio" for n in board.get("nodes", [])):
        return auth.err(404, "音频节点已不存在")
    if not isinstance(attempt, str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}", attempt):
        raise bad("音频任务编号格式无效")
    text = raw.get("prompt")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 3000:
        raise bad("请填写 1 到 3000 字的配音文案或声音描述")
    route = next((r for r in audio_routes(cap) if not raw.get("provider") or r["provider"]["id"] == raw["provider"]), None)
    if not route:
        return auth.err(503, "所选音频服务不可用，请检查控制台配置")
    provider, model = route["provider"], route["model"]
    if isinstance(req, agent_chat.InternalRequest):
        if req.get("fixed_audio_model") not in (None, model):
            return auth.err(409, "原音频模型已变更，请重新配置后再重试")
        req["generation_model"] = model
    recipe = {"mode":cap,"prompt":text.strip(),"provider":provider["id"]}
    if cap == "tts":
        voice = raw.get("voice") or (route["voices"][0]["id"] if route["voices"] else "")
        if not any(v["id"] == voice for v in route["voices"]):
            raise bad("请选择所选服务提供的音色")
        try:
            low, high = route.get("speed_range", (.5,2))
            speed = image_editor.number(raw.get("speed"), low, high, "语速", 1)
        except ValueError as exc:
            raise bad(str(exc)) from None
        recipe.update(voice=voice,speed=speed)
        subtitles = raw.get("subtitles",False)
        if type(subtitles) is not bool or subtitles and not route.get("subtitles"):
            raise bad("所选配音服务不支持生成同步字幕")
        if route.get("subtitles"):
            recipe["subtitles"] = subtitles
    elif cap == "music":
        lyrics = raw.get("lyrics","")
        if not isinstance(lyrics, str) or len(lyrics.strip()) > 3000:
            raise bad("歌词最多 3000 字")
        recipe["lyrics"] = lyrics.strip()
    elif cap == "seed_audio":
        recipe["references"] = seed_audio_bindings(board,user,raw.get("references",[]),nid)
        seed_audio_prompt(recipe["prompt"],recipe["references"])
        subtitles = raw.get("subtitles",False)
        if type(subtitles) is not bool:
            raise bad("字幕选项格式无效")
        recipe["subtitles"] = subtitles
    else:
        duration, influence, loop = raw.get("duration_seconds"), raw.get("prompt_influence", .3), raw.get("loop", False)
        if duration is not None and (type(duration) not in (int,float) or not .5 <= duration <= 30):
            raise bad("音效时长须在 0.5–30 秒之间")
        if type(influence) not in (int,float) or not 0 <= influence <= 1:
            raise bad("提示词影响须在 0–1 之间")
        if type(loop) is not bool:
            raise bad("音效循环参数无效")
        recipe.update(duration_seconds=duration,prompt_influence=influence,loop=loop)
    output = raw.get("audio_format","source")
    if not isinstance(output,str) or (output != "source" and output not in film.AUDIO_OUTPUT_RATES):
        raise bad("请选择支持的音频输出格式")
    if output != "source":
        rates = film.AUDIO_OUTPUT_RATES[output]
        rate = raw.get("sample_rate")
        if rate is None:
            rate = 44100 if 44100 in rates else rates[0]
        if type(rate) is not int or rate not in rates:
            raise bad("所选格式不支持这个采样率")
        recipe.update(audio_format=output,sample_rate=rate)
    pitch, gain = raw.get("pitch_semitones",0), raw.get("gain",1)
    if type(pitch) is not int or not -12 <= pitch <= 12:
        raise bad("音高须在 -12 至 +12 半音之间，并使用整数")
    if type(gain) not in (int,float) or not .5 <= gain <= 2:
        raise bad("音量须在 0.5 至 2 倍之间")
    if pitch:
        recipe["pitch_semitones"] = pitch
    if gain != 1:
        recipe["gain"] = gain
    jid = "t" + hashlib.sha256(f"{user['id']}:{bid}:{nid}:{attempt}".encode()).hexdigest()[:12]
    fingerprint = hashlib.sha256(json.dumps([recipe,model], sort_keys=True).encode()).hexdigest()
    if prior := db.one("SELECT request FROM tasks WHERE id=? AND user_id=?", jid, user["id"]):
        if json.loads(prior["request"]).get("fingerprint") != fingerprint:
            return auth.err(409, "这次提交的音频参数已变更")
        return web.json_response({"ids":[jid],"recipe":recipe})
    if nid and any(j["state"] in ("queued","running") and (info:=j.get("meta",{})).get("board") == bid and
                   info.get("audio_node") == nid for j in JOBS.values()):
        return auth.err(409, "此音频节点已有任务")
    mode = AUDIO_GENERATION_MODES[cap]
    label = clean(raw.get("label"))[:60] or mode
    meta = {"uid":user["id"],"board":bid,"audio_node":nid,"label":label,"provider":provider["name"],
            "model":model,"mode_name":mode,"est":10 if cap=="tts" else 60}
    job = JOBS[jid] = {"id":jid,"kind":"audio","state":"queued","created":time.time(),"meta":meta}
    db.task_start(id=jid,user_id=user["id"],board_id=bid,label=label,capability=cap,provider_id=provider["id"],
                  provider_kind=provider["kind"],model=model,request={"fingerprint":fingerprint,"recipe":recipe})
    asyncio.create_task(run_audio(req.app, job, provider, model, recipe))
    return web.json_response({"ids":[jid],"recipe":recipe})


async def run_audio(app, job, provider, model, recipe):
    jid, cap = job["id"], recipe["mode"]
    async with REMOTE_SEM.setdefault(provider["id"], asyncio.Semaphore(3)):
        if job.get("cancel"):
            return
        job.update(state="running", phase="sampling", started=time.time())
        db.task_update(jid,state="running",started=job["started"])
        try:
            usage = {}
            if provider["kind"] == "local_kokoro":
                result = await tts.say(COMFY_DIR,recipe["prompt"],recipe["voice"],recipe["speed"])
                ref = result["ref"]
            else:
                if cap == "tts":
                    request = {"text":recipe["prompt"],"voice":recipe["voice"],"speed":recipe["speed"]}
                    if recipe.get("subtitles"):
                        request["subtitles"] = True
                elif cap == "seed_audio":
                    refs = recipe["references"]
                    request = {"prompt":seed_audio_prompt(recipe["prompt"],refs),"subtitles":recipe["subtitles"],
                               "references":await asyncio.to_thread(seed_audio_reference_bytes,refs)}
                else:
                    keys = ("lyrics",) if cap == "music" else ("duration_seconds","prompt_influence","loop")
                    request = {key:recipe[key] for key in ("prompt",*keys)}
                result = await remote.run(app["http"],COMFY_DIR,provider,model,cap,request)
                ref = result["files"][0]["ref"]
                usage = {key:result[key] for key in ("cost","units") if result.get(key) is not None}
            if job.get("cancel"):
                return
            path = tools.ref_path(COMFY_DIR,ref)
            output = recipe.get("audio_format")
            pitch, gain = recipe.get("pitch_semitones",0), recipe.get("gain",1)
            if output or pitch or gain != 1:
                original = path.suffix.lower().lstrip(".")
                output = output or (original if original in film.AUDIO_OUTPUT_RATES else "wav")
                target, ref = film._new(COMFY_DIR,"output","audio_export","."+output)
                job["phase"] = "compositing"
                await asyncio.to_thread(film.encode_audio_delivery,path,target,output,recipe.get("sample_rate"),
                                        lambda:bool(job.get("cancel")),pitch=pitch,gain=gain)
                path = target
            duration = await asyncio.to_thread(film.audio_duration,path)
            if path.suffix.lower() not in tools.AUDIO_EXT or not math.isfinite(duration) or duration <= 0:
                raise ValueError("服务未返回可播放音频")
            extra = {"audio_recipe":recipe}
            if recipe.get("subtitles"):
                cues = []
                for cue in (result.get("captions") or [])[:film.CAPTION_LIMIT]:
                    start = max(round(cue["start"],3),cues[-1]["end"] if cues else 0)
                    end = min(round(duration,3),round(cue["end"],3))
                    if end > start:
                        cues.append({"start":start,"end":end,"text":cue["text"]})
                if cues:
                    extra["audio_transcript"] = {"start":0,"end":round(duration,3),"cues":cues}
            await complete_outputs(job,[{"ref":ref,"url":"/media?ref="+quote(ref,safe=""),"meta":{"duration":duration},
                                        "extra":extra}])
            db.task_update(jid,**usage)
        except Exception as error:
            if not job.get("cancel"):
                job.update(state="error",error=f"音频生成失败：{error}"[:500])
        log_end(job)


@routes.get("/api/queue")
async def queue(req):
    """Everything this canvas has queued or running, in order, with the time until each is done."""
    try:
        async with req.app["http"].get(f"{COMFY}/queue", timeout=aiohttp.ClientTimeout(total=3)) as r:
            q = await r.json()
        order = [x[1] for x in q.get("queue_running", [])] + [x[1] for x in sorted(q.get("queue_pending", []), key=lambda x: x[0])]
    except Exception:
        order = []
    out, t = [], 0.0
    for i in order:                      # ComfyUI's queue, in execution order (foreign jobs count with a guess)
        j = JOBS.get(i)
        if j and j["state"] in ("done", "error"):
            continue
        t += remaining(j) if j else 90
        if j:
            m = j.get("meta") or {}
            out.append({"id": i, "kind": j["kind"], "state": j["state"], "label": m.get("label") or ("图片" if j["kind"] == "image" else "视频"),
                        "eta": round(t), "value": j.get("value"), "max": j.get("max")})
    for i, j in JOBS.items():            # our engine's jobs, in submission order (those still being prepared last)
        if j.get("out_ref") and j["state"] in ("queued", "running"):
            t += remaining(j)
            m = j.get("meta") or {}
            out.append({"id": i, "kind": j["kind"], "state": j["state"], "label": m.get("label") or ("图片" if j["kind"] == "image" else "视频"), "eta": round(t), "value": j.get("value"), "max": j.get("max")})
    for i, j in JOBS.items():
        if j.get("prep") and j["state"] == "queued":
            t += remaining(j)
            m = j.get("meta") or {}
            out.append({"id": i, "kind": j["kind"], "state": "queued", "label": (m.get("label") or "视频") + " · 翻译提示词", "eta": round(t), "value": None, "max": None})
    rt = 0.0
    for i, j in JOBS.items():            # renders run beside ComfyUI
        if j.get("kind") == "render" and j["state"] in ("queued", "running"):
            rt += remaining(j)
            out.append({"id": i, "kind": "render", "state": j["state"], "label": (j.get("meta") or {}).get("label") or "成片",
                        "eta": round(rt), "value": j.get("value"), "max": j.get("max")})
    audio_eta = 0
    for i,j in JOBS.items():
        if j.get("kind")=="audio" and j["state"] in ("queued","running"):
            eta = round(remaining(j))
            audio_eta = max(audio_eta,eta)
            out.append({"id":i,"kind":"audio","state":j["state"],"label":j["meta"]["label"],"eta":eta})
    foreign = sum(1 for i in order if i not in JOBS)
    return web.json_response({"jobs": out, "total": round(max(t, rt, audio_eta)), "foreign": foreign})


LLM_PRESETS = {
    "deepseek": {"name": "DeepSeek", "base_url": "https://api.deepseek.com", "model": "deepseek-flash"},
    "local": {"name": "本机 DeepSeek", "base_url": "http://127.0.0.1:8080/v1", "model": "deepseek"},
}


def settings_load() -> dict:
    try:
        return json.loads(rewriter.SETTINGS.read_text())
    except Exception:
        return {}


def mask(k: str) -> str:
    return (k[:3] + "…" + k[-4:]) if k and len(k) > 10 else ("已设置" if k else "")


@routes.get("/api/settings")
async def get_settings(_):
    r = dict(settings_load().get("llm") or {})
    r["api_key_masked"] = mask(r.pop("api_key", ""))
    return web.json_response({"llm": r, "presets": LLM_PRESETS})


@routes.put("/api/settings")
async def put_settings(req):
    p = (await req.json()).get("llm") or {}
    s = settings_load()
    cur = s.get("llm") or {}
    new = {k: clean(p.get(k)) for k in ("provider", "name", "base_url", "model")}
    new["enabled"] = bool(p.get("enabled"))
    new["api_key"] = clean(p["api_key"]) if p.get("api_key") is not None else cur.get("api_key", "")   # omitted = keep
    if new["enabled"] and not (new["base_url"] and new["model"]):
        raise bad("请填写接口地址和模型名")
    s["llm"] = new
    rewriter.SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    tmp = rewriter.SETTINGS.with_suffix(".tmp"); tmp.write_text(json.dumps(s, ensure_ascii=False, indent=1)); os.chmod(tmp, 0o600); tmp.replace(rewriter.SETTINGS)
    return web.json_response({"ok": True})


@routes.post("/api/settings/test")
async def test_settings(req):
    """Try the remote with a tiny request; also list its models when it can."""
    p = (await req.json()).get("llm") or {}
    cur = settings_load().get("llm") or {}
    cfg = {"name": clean(p.get("name")) or "DeepSeek", "base_url": clean(p.get("base_url")), "model": clean(p.get("model")),
           "api_key": clean(p["api_key"]) if p.get("api_key") else cur.get("api_key", "")}
    if not cfg["base_url"] or not cfg["model"]:
        raise bad("请填写接口地址和模型名")
    t0 = time.time()
    try:
        out = await rewriter.remote_chat(req.app["http"], cfg, "只回复两个字：成功", "测试", max_tokens=16, temperature=0)
    except Exception as e:
        raise bad(str(e) or e.__class__.__name__)
    models = []
    try:
        u = cfg["base_url"].rstrip("/") + ("/models" if cfg["base_url"].rstrip("/").endswith("/v1") or "deepseek.com" in cfg["base_url"] else "/v1/models")
        async with req.app["http"].get(u, headers={"Authorization": "Bearer " + cfg["api_key"]} if cfg["api_key"] else {},
                                       timeout=aiohttp.ClientTimeout(total=10)) as r:
            models = [m.get("id") for m in (await r.json(content_type=None)).get("data", []) if m.get("id")]
    except Exception:
        pass
    return web.json_response({"reply": out[:40], "seconds": round(time.time() - t0, 1), "models": models})


SAMPLES = DATA / "samples"


@routes.get("/api/samples")
async def samples(_):
    """Finished example films made from the wizard's templates (data/samples/samples.json + their boards)."""
    try:
        return web.json_response(json.loads((SAMPLES / "samples.json").read_text()))
    except Exception:
        return web.json_response([])


@routes.post("/api/samples/{sid}/open")
async def sample_open(req):
    """Copy a sample's whole project into a new board, so every step can be looked at and changed."""
    sid = req.match_info["sid"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
        raise bad("bad id")
    src = SAMPLES / "boards" / f"{sid}.json"
    if not src.is_file():
        raise bad("示例不存在")
    b = json.loads(src.read_text())
    b["name"] = (b.get("name") or "示例") + "（副本）"
    b["owner"] = req["user"]["id"]; b["shared"] = False
    b.pop("collaborators", None)
    b.pop("access", None)
    for n in b.get("nodes", []):
        n["job"] = None
    bid = "b" + uuid.uuid4().hex[:10]
    write_board(board_path(bid), b)
    return web.json_response({"id": bid})


# ================================================================ our own H3 engine (no ComfyUI)

ENGINE = os.environ.get("H3_ENGINE_URL", "http://127.0.0.1:8189")


async def engine_up(app, image: bool = False) -> bool:
    try:
        async with app["http"].get(ENGINE + "/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
            s = await r.json()
            return bool(s.get("ready")) and (not image or bool(s.get("image_ready")))
    except Exception:
        return False


async def generate_engine_image(req, p: dict, count: int):
    """H3-Image on our engine: text-to-image, or editing with the linked images as <Picture 1..n>."""
    u = req["user"]
    imgs = p.get("images") or []
    ar = float(p.get("ar") or 1)
    mp = 16.0 if p.get("quality") == "16mp" else 4.0
    w, h = size_for(ar, mp, 32)
    prompt = re.sub(r"@图(\d+)", r"<Picture \1>", p["prompt"])
    paths = [str(tools.ref_path(COMFY_DIR, im["ref"])) for im in imgs]
    cls, units, dflt = job_class(p)
    meta = {"prompt": p["prompt"], "cls": cls, "units": units, "est": estimate(cls, units, dflt), "label": clean(p.get("label"))[:60],
            "uid": u["id"], "board": clean(p.get("board")), "engine": True, "width": w, "height": h,
            "mode_name": ("以图改图" if paths else "文生图") + f" · {round(w * h / 1e6)}MP"}
    ids = []
    for k in range(max(1, min(4, count))):
        seed = seed_of(p.get("seed")) + k
        name = f"image_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:5]}.png"
        out = COMFY_DIR / "output" / "h3studio" / name
        out.parent.mkdir(parents=True, exist_ok=True)
        async with req.app["http"].post(ENGINE + "/jobs", json={"kind": "image", "prompt": prompt, "images": paths, "height": h, "width": w,
                                                                "seed": seed, "out": str(out)}) as r:
            jid = (await r.json())["id"]
        JOBS[jid] = {"id": jid, "kind": "image", "state": "queued", "created": time.time(), "meta": dict(meta, seed=seed),
                     "out_ref": f"output:h3studio/{name}"}
        attach_image_edit(JOBS[jid], p)
        db.task_start(id=jid, user_id=u["id"], board_id=meta["board"], label=meta["label"], capability="image", provider_id="local_h3",
                      provider_kind="local_h3", model="H3-Image " + meta["mode_name"], state="queued", cost=0)
        ids.append(jid)
    asyncio.create_task(follow_engine(req.app))
    return web.json_response({"ids": ids, "meta": JOBS[ids[0]]["meta"]})


async def generate_native_image(req, p):
    native = p["_native_inpaint"]
    # Native SD prompts use CLIP's English vocabulary. Translate through the configured text route when needed.
    prompt = native["prompt"]
    if re.search(r"[\u4e00-\u9fff]", prompt):
        llm = req.app["llm"]
        try:
            prompt = clean(await llm.chat("Translate the image editing instruction into a concise English image description. Return only the English description, without commentary.", prompt, max_tokens=180, temperature=.1))
        except Exception as e:
            raise bad(f"原生重绘提示词翻译失败：{e}；也可直接填写英文")
        if llm.running() and llm.device == "GPU":
            llm.stop()
    out, ref = tools._new(COMFY_DIR, "output", "inpaint", ".png")
    seed = seed_of(p.get("seed"))
    body = {**native, "kind": "inpaint", "prompt": prompt, "seed": seed, "out": str(out),
            "image": str(tools.ref_path(COMFY_DIR, native["image"])), "mask": str(tools.ref_path(COMFY_DIR, native["mask"]))}
    try:
        async with req.app["http"].post(ENGINE + "/jobs", json=body, timeout=aiohttp.ClientTimeout(total=10)) as r:
            response = await r.json()
            if r.status != 200 or not response.get("id"):
                raise ValueError(response.get("error") or "原生重绘引擎未就绪")
    except (ValueError, aiohttp.ClientError, asyncio.TimeoutError) as e:
        raise bad(str(e))
    jid = response["id"]; uid = req["user"]["id"]
    meta = {"prompt": p["_image_edit"]["prompt"], "label": clean(p.get("label"))[:60], "uid": uid,
            "board": clean(p.get("board")), "seed": seed, "engine": True, "est": 25, "cls": "native-inpaint", "units": 1}
    j = JOBS[jid] = {"id": jid, "kind": "image", "state": "queued", "created": time.time(), "meta": meta, "out_ref": ref}
    attach_image_edit(j, p)
    db.task_start(id=jid, user_id=uid, board_id=meta["board"], label=meta["label"], capability="image", provider_id="local_h3",
                  provider_kind="local_h3", model="SD 原生遮罩重绘", state="queued", cost=0)
    asyncio.create_task(follow_engine(req.app))
    return web.json_response({"ids": [jid], "meta": meta})


async def generate_engine(req, p: dict, count: int):
    """Queue the video at once (ids 'p…'); the prompt is translated to English and the job handed to the engine in the
    background, in click order, so 生成 answers immediately."""
    u = req["user"]
    _, meta = graph_video(p)                         # mode name, seed and size for the queue entry (prompt rebuilt later)
    cls, units, dflt = job_class(p)
    meta.update(prompt=p["prompt"], cls=cls, units=units, est=estimate(cls, units, dflt), label=clean(p.get("label"))[:60], uid=u["id"],
                board=clean(p.get("board")), engine=True)
    pids = []
    for k in range(count):
        pid = "p" + uuid.uuid4().hex[:12]
        m = dict(meta, seed=meta["seed"] + k)
        JOBS[pid] = {"id": pid, "kind": "video", "state": "queued", "prep": True, "created": time.time(), "meta": m}
        db.task_start(id=pid, user_id=u["id"], board_id=m["board"], label=m["label"], capability="video", provider_id="local_h3",
                      provider_kind="local_h3", model="MiniMax-H3 " + m["mode_name"], state="queued", cost=0)
        pids.append(pid)
    prev = PREP_TAIL[0]
    PREP_TAIL[0] = asyncio.create_task(prepare_engine(req.app, p, pids, prev))
    return web.json_response({"ids": pids, "meta": JOBS[pids[0]]["meta"]})


PREP_TAIL = [None]   # the last prepare task: each one waits for the one before, so jobs reach the engine in click order


async def prepare_engine(app, p: dict, pids: list, prev):
    if prev is not None:
        try:
            await prev
        except Exception:
            pass
    if not any(JOBS.get(i, {}).get("state") == "queued" for i in pids):
        return                                       # all cancelled while waiting
    try:
        q = await to_english(app, p)
        llm = app["llm"]
        if llm.running() and llm.device == "GPU":
            llm.stop()                               # give the GPU back to the engine
        body, meta = engine_body(q)
        for pid in pids:
            j = JOBS.get(pid)
            if not j or j["state"] != "queued":
                continue
            m = dict(meta, **{k: j["meta"][k] for k in ("prompt", "cls", "units", "est", "label", "uid", "board", "engine", "seed")})
            if q.get("_xlate_err"):
                m["mode_name"] = m.get("mode_name", "") + " · 未翻译"
            name = f"video_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:5]}.mp4"
            out = COMFY_DIR / "output" / "h3studio" / name
            out.parent.mkdir(parents=True, exist_ok=True)
            async with app["http"].post(ENGINE + "/jobs", json={**body, "seed": m["seed"], "out": str(out)}) as r:
                jr = await r.json()
            if j.get("cancel"):
                if jr.get("id"):
                    await cancel_engine_jobs(app, [jr["id"]])
                continue
            if "id" not in jr:
                j["state"] = "error"; j["error"] = f"本地引擎拒绝了任务：{jr.get('error')}"; log_end(j)
                continue
            j.update(meta=m, eid=jr["id"], out_ref=f"output:h3studio/{name}")
            db.task_update(pid, request=json.dumps({"engine": {"id": j["eid"], "out_ref": j["out_ref"]},
                                                    "history":{**video_job_details(m),"seed":m["seed"]}}))
            j.pop("prep", None)
        asyncio.create_task(follow_engine(app))
    except Exception as e:
        for pid in pids:
            j = JOBS.get(pid)
            if j and j["state"] == "queued":
                j["state"] = "error"; j["error"] = f"提交失败：{e}"; log_end(j)


def engine_body(p: dict):
    """The same request the ComfyUI graph was built from, sent to the engine: prompt, keyframes or references, size."""
    g, meta = graph_video(p)                         # reuse the prompt building (official structure, @图 names, times)
    ar = float(p.get("ar") or 16 / 9)
    short = 768 if p.get("quality", "hd") == "hd" else 480
    long_ = min(int(round(short * max(ar, 1 / ar) / 32)) * 32, (1032192 // short) // 32 * 32)
    meta["width"], meta["height"] = (long_, short) if ar >= 1 else (short, long_)
    meta.update(provider="本地 H3",model="h3-video",resolution=f"{short}P")
    imgs = p.get("images") or []
    paths = [str(tools.ref_path(COMFY_DIR, im["ref"])) for im in imgs]
    body = {"kind": "video", "prompt": meta["full_prompt"], "frames": engine_video_frames(float(p.get("duration") or 5)), "height": meta["height"],
            "width": meta["width"], "steps": meta["steps"], "turbo": bool(p.get("turbo", True))}
    mode = meta["mode"]
    nframes = body["frames"]
    at = lambda t: max(0, min(nframes - 4, round(float(t or 0) * 24)))   # the pixel frame a keyframe is anchored at
    if mode == "planned":                          # character references + keyframes at their times (ComfyUI AddGuide)
        subj = [str(tools.ref_path(COMFY_DIR, im["ref"])) for im in imgs if im.get("role") == "subject"][:9]
        frames = sorted([im for im in imgs if im.get("role") != "subject"], key=lambda im: float(im.get("time") or 0))
        body["references"] = subj
        body["keyframes"] = [{"path": str(tools.ref_path(COMFY_DIR, im["ref"])), "frame": at(im.get("time"))} for im in frames]
    elif mode == "reference":
        body["references"] = paths[:9]
    elif mode == "keyframes":                      # like the ComfyUI graph: the first image as reference, the rest anchored
        times = meta.get("times") or []
        body["references"] = paths[:1]
        body["keyframes"] = [{"path": paths[i], "frame": at(times[i] if i < len(times) else 0)} for i in range(1, len(paths))]
    elif paths:
        body["image"] = paths[0]
        if len(paths) > 1:
            body["last_image"] = paths[-1]
    return body, meta


def video_job_details(meta):
    details = {key:meta[key] for key in ("mode","mode_name","provider","model","resolution") if isinstance(meta.get(key),str)}
    if isinstance(meta.get("full_prompt"),str):
        details["full_prompt"] = meta["full_prompt"][:5000]
    return details


_following = False


def job_from_log(row):
    cap = row.get("capability")
    kind = "audio" if cap in AUDIO_GENERATION_MODES or cap == "audio_separation" else "image" if cap == "image" else "video"
    return {"id":row["id"], "kind":kind, "state":row["state"], "created":row.get("created") or time.time(),
            "meta":{"label":row.get("label"), "uid":row.get("user_id"), "board":row.get("board_id"),
                    "mode_name":(row.get("model") or "").replace("MiniMax-H3 ", "")}}


def restore_logged_job(app, row):
    jid = row["id"]
    if jid in JOBS:
        return JOBS[jid]
    job = job_from_log(row)
    request = task_settings(row.get("request"))
    if job["kind"] == "video":
        job["meta"].update(video_job_details(request))
        if isinstance(request.get("prompt"),str):
            job["meta"]["prompt"] = request["prompt"]
        if row.get("provider_kind") in ("ark","kling","minimax") and row.get("model"):
            job["meta"]["model"] = row["model"]
    history = request.get("history")
    if isinstance(history,dict):
        job["meta"].update({key:history[key] for key in ("seed","mode_name") if key in history})
        if job["kind"] == "video":
            job["meta"].update(video_job_details(history))
    if row["state"] in ("done", "error"):
        try:
            refs = json.loads(row.get("outputs") or "[]")
        except (ValueError, TypeError):
            refs = []
        outputs = []
        image_edits = request.get("image_edits")
        for index, ref in enumerate(refs if isinstance(refs,list) else []):
            if not isinstance(ref, str):
                continue
            try:
                path = tools.ref_path(COMFY_DIR, ref)
            except ValueError:
                continue
            stem = None
            if row.get("capability") == "audio_separation":
                stems = tuple(audio_separation.STEMS)
                if index >= len(stems) or not path.is_file():
                    continue
                stem = stems[index]
            outputs.append({"ref":ref, "url":"/media?ref=" + quote(ref, safe=""),
                            "meta":media_info(path, job["kind"])})
            if row.get("capability") in AUDIO_GENERATION_MODES:
                extra = {key:request[source] for key,source in (("audio_recipe","recipe"),("audio_transcript","audio_transcript"))
                         if isinstance(request.get(source),dict)}
                if extra:
                    outputs[-1]["extra"] = extra
            if job["kind"]=="image" and isinstance(image_edits,dict) and isinstance(image_edits.get(ref),dict):
                outputs[-1]["extra"] = {"source":"edit","edit":image_edits[ref]}
            if stem:
                outputs[-1]["extra"] = {"stem":stem}
            if draft := db.one("SELECT expires FROM video_drafts WHERE ref=? AND job_id=?", ref, jid):
                outputs[-1].setdefault("extra",{})["draft_expires"] = draft["expires"]
            if Path(ref).name.startswith("ai_") and db.one("SELECT 1 FROM task_watermarks WHERE job_id=?",jid):
                outputs[-1].setdefault("extra",{})["ai_watermark"] = True
        job.update(error=row.get("error"), outputs=outputs, _logged=True)
        JOBS[jid] = job
        return job
    receipt = request.get("engine") or {}
    if not isinstance(receipt, dict):
        receipt = {}
    if not receipt and len(jid) == 13 and jid[0] == "e" and row.get("provider_kind") == "local_h3":
        receipt = {"id":jid, "out_ref":"output:h3studio/pending"}
    if receipt.get("id") and receipt.get("out_ref"):
        job.update(eid=receipt["id"], out_ref=receipt["out_ref"])
        job["meta"]["engine"] = True
        JOBS[jid] = job
        restore_image_edit(job)
        asyncio.create_task(follow_engine(app))
        return job
    receipt = request.get("remote_video")
    if row.get("capability") == "video" and isinstance(receipt, dict):
        JOBS[jid] = job
        provider = providers.get(row["provider_id"])
        if not provider or not provider["enabled"] or provider["kind"] != row.get("provider_kind"):
            job.update(state="error", error="原视频服务已停用或变更，无法查询任务")
            log_end(job)
        else:
            job["started"] = row.get("started") or job["created"]
            job["meta"].setdefault("provider",provider["name"])
            start_remote(app, job, provider, row["model"], "video", {}, receipt=receipt)
        return job
    remote_final = len(jid) == 25 and jid.startswith("r") and row.get("provider_kind") == "ark" and row.get("capability") == "video"
    if not remote_final and (len(jid) != 13 or jid[0] not in "epxrt"):
        return None
    message = ("OneShot 已重启，未保存第三方任务号。请先到视频服务查询提交记录"
               if remote_final or (jid.startswith("x") and row.get("capability") == "video")
               else "OneShot 已重启，此任务无法恢复，请重试")
    job.update(state="error", error=message)
    JOBS[jid] = job
    log_end(job)
    return job


async def follow_engine(app):
    """Mirror the engine's job states into JOBS (one follower for all jobs)."""
    global _following
    if _following:
        return
    _following = True
    try:
        while True:
            live = [i for i, j in JOBS.items() if j.get("out_ref") and j["state"] in ("queued", "running")]
            if not live:
                return
            try:
                async with app["http"].get(ENGINE + "/jobs", params={"ids": ",".join(JOBS[i].get("eid", i) for i in live)},
                                           timeout=aiohttp.ClientTimeout(total=5)) as r:
                    r.raise_for_status()
                    st = await r.json()
                if not isinstance(st, dict):
                    raise ValueError("Invalid engine status response")
            except Exception:
                await asyncio.sleep(3); continue
            for i in live:
                j = JOBS.get(i)
                if not j or j["state"] not in ("queued", "running"):
                    continue
                s = st.get(j.get("eid", i))
                if not isinstance(s, dict):
                    continue
                if s.get("state") == "queued":
                    j["ahead"] = s.get("ahead", 0)
                    j["phase"] = "queued"
                if s.get("state") == "running":
                    if j["state"] != "running":
                        j["state"] = "running"; j["started"] = s.get("started") or time.time()
                    j["value"], j["max"] = s.get("value"), s.get("max")
                    j["phase"] = s.get("phase") or ("decoding" if s.get("max") and (s.get("value") or 0) >= s["max"] else "sampling")
                    j["ahead"] = s.get("ahead", 0)
                elif s.get("state") == "done":
                    if s.get("out"):
                        j["out_ref"] = "output:h3studio/" + Path(s["out"]).name
                    path = COMFY_DIR / "output" / "h3studio" / Path(j["out_ref"]).name
                    j["started"] = s.get("started") or j.get("started")
                    await complete_outputs(j, [{"ref": j["out_ref"], "url": "/media?ref=" + quote(j["out_ref"], safe=""), "meta": media_info(path, j["kind"])}])
                elif s.get("state") == "error":
                    j["state"] = "error"; j["error"] = s.get("error") or "生成失败"; log_end(j)
            await asyncio.sleep(1.5)
    finally:
        _following = False


# ================================================================ third-party providers: jobs, console API

def plain_prompt(p: dict) -> str:
    """Fields → one Chinese paragraph for third-party models (they don't speak H3's structured format)."""
    f = p.get("fields")
    if not isinstance(f, dict) or not pfields.has_content(f):
        return clean(p.get("prompt"))
    lab = [("style", "风格"), ("scene", "场景"), ("people", "人物"), ("camera", "镜头"), ("action", "动作"), ("dialogue", "对白"), ("sound", "声音"), ("music", "配乐")]
    parts = [f"{t}：{'；'.join(x.strip() for x in str(f.get(k) or '').splitlines() if x.strip())}" for k, t in lab if str(f.get(k) or "").strip()]
    if clean(p.get("prompt")):
        parts.append(clean(p.get("prompt")))
    return "。".join(parts)


def remote_video_prompt(raw, provider, model):
    images = raw.get("images") or []
    if limit := image_reference_limit(raw,provider,model):
        if len(images)>limit:
            raise bad(f"此模型最多支持 {limit} 张参考图")
        if any(not 1 <= int(mark) <= len(images) for mark in re.findall(r"@(?:图|图片)(\d+)",plain_prompt(raw))):
            raise bad("提示词引用的参考图不存在，请重新选择")
        prompt = video_reference_prompt(raw,provider,model,guide_frames=True)
        return prompt, ["image_ref"]*len(images)
    frames = [i for i, image in enumerate(images) if image.get("role") != "subject"]
    subjects = [i for i, image in enumerate(images) if image.get("role") == "subject"]
    kling = provider["kind"] == "kling"
    roles = ["unused_image"] * len(images)
    labels = {}
    if frames:
        roles[frames[0]], labels[frames[0]] = "first_frame", "首帧画面"
        if len(frames) > 1 and not (kling and (subjects or "flash" in model)):
            roles[frames[-1]], labels[frames[-1]] = "last_frame", "尾帧画面"
    if kling or not frames:
        for number, i in enumerate(subjects[:7 if kling else 9], 1):
            roles[i], labels[i] = "subject", f"第 {number} 张人物参考图"

    def replace(match):
        i = int(match[1]) - 1
        if i not in labels:
            raise bad(f"当前视频服务无法采用 {match[0]}，请调整参考素材或切换视频服务")
        return labels[i]

    prompt = _IMAGE_MENTION.sub(replace,plain_prompt(raw))
    if is_cloud_h3(provider,model):
        prompt = video_prompt_adapters.h3_cloud_prompt(prompt)
    return prompt,roles


def wants_image_references(raw):
    images = raw.get("images") or []
    return len(images)>2 or any(image.get("role")=="subject" for image in images)


def image_reference_limit(raw, provider, model):
    if wants_image_references(raw):
        return motion_reference.image_reference_limit(provider,model)
    return None


def has_remote_image_references(raw, route):
    return bool(route and image_reference_limit(raw,route["provider"],route["model"]))


def configured_models(provider, cap, routes):
    models = [providers.default_model(provider, cap)]
    models.extend(route["model"] for route in routes if route["provider"]["id"] == provider["id"])
    if cap == "video" and provider["kind"] == "ark":
        models.extend(provider.get("config",{}).get("video_endpoint_models",{}))
    return list(dict.fromkeys(model for model in models if model))


def reference_routes(*, require_motion=False, segment_edit=False, extension=False, all_models=False, image_only=False):
    check = motion_reference.supports if require_motion or segment_edit else motion_reference.supports_audio
    def supports(provider, model):
        if image_only:
            return (provider["enabled"] and provider.get("secrets",{}).get("api_key")
                    and motion_reference.image_reference_limit(provider,model))
        return (check(provider,model) and (not extension or provider["kind"] == "ark") and
                (not segment_edit or "seedance-2-5" in motion_reference.video_model_for_limits(provider,model)))
    choices = {}
    routes = providers.routes("video")
    defaults = [{"provider":p,"model":model} for p in providers.all_providers()
                for model in configured_models(p,"video",[])]
    for route in [*routes, *defaults]:
        provider, model = route["provider"], route["model"]
        if supports(provider, model):
            key = (provider["id"], model) if all_models else provider["id"]
            choices.setdefault(key, route)
    return list(choices.values())


def requested_reference_routes(raw):
    has_motion = raw.get("previs_guide") is not None or bool(raw.get("video_refs"))
    edit = bool(raw.get("segment_edit"))
    selected = raw.get("selected_model")
    auto = not raw.get("provider") and selected is None
    routes = reference_routes(require_motion=has_motion,segment_edit=edit,extension=bool(raw.get("extension")),
                              all_models=selected is not None or auto)
    if auto and routes:
        return routes
    for route in routes:
        if route["provider"]["id"] == raw.get("provider") and (selected is None or route["model"] == selected):
            return [route]
    if selected is not None:
        raise bad("所选模型不支持当前参考素材或已不可用，请重新选择模型")
    if edit:
        raise bad("请选择已配置参考视频公网地址的 Seedance 2.5 服务")
    if has_asset_media(raw):
        raise bad("资产包含音频或视频参考，请选择支持全模态参考的视频服务" +
                  ("，并配置参考视频公网地址" if has_motion else ""))
    raise bad("请选择支持全模态参考的视频服务" + ("，并配置参考视频公网地址" if has_motion else ""))


def reference_video_duration(raw, provider, model, motion):
    from_previs = motion and motion.get("source") == "previs"
    limit = 14 if from_previs and not raw.get("extension") else remote.video_durations(provider["kind"],model,provider=provider)[-1]
    try:
        seconds = image_editor.number(raw.get("duration"),2,limit,"成片时长",5)
    except ValueError as exc:
        raise bad(str(exc)) from None
    return remote.video_duration(provider["kind"],model,seconds,provider=provider)


def checked_video_resolution(raw,kind,model,*,provider=None):
    quality = raw.get("quality") or "hd"
    if quality in ("480p","4k") and (raw.get("draft") or quality not in remote.video_resolutions(kind,model,provider=provider)):
        raise bad(f"当前生成模式不支持 {quality.upper()}，请更改分辨率或模型")
    return "480p" if raw.get("draft") else remote.video_resolution(kind,model,quality,provider=provider)


def check_reference_operation(raw):
    entries = raw.get("video_refs")
    has_source_clip = isinstance(entries,list) and bool(entries) and isinstance(entries[0],dict) and not entries[0].get("memory_id")
    extension = raw.get("extension")
    if extension is not None and (extension not in ("before","after") or not has_source_clip):
        raise bad("请选择续拍方向和原视频")
    edit = raw.get("segment_edit")
    if edit is not None and (edit is not True or extension or not has_source_clip):
        raise bad("请选择要修改的原视频片段")


async def check_reference_inputs(user, raw, provider, model, motion, object_plan):
    model_for_limits = motion_reference.video_model_for_limits(provider,model)
    ensure_reference_media_count(raw,provider["kind"],model_for_limits,object_plan)
    clips = await resolve_video_refs(user,raw,model_for_limits,motion) if raw.get("video_refs") else []
    audio = await resolve_audio_refs(user,raw,model_for_limits,provider_kind=provider["kind"]) if raw.get("audio_refs") else []
    return clips,audio


async def prepare_reference_generation(user, raw, object_plan, *, fixed_route=None):
    routes = requested_reference_routes(raw)
    if fixed_route:
        routes = [route for route in routes if route["provider"]["id"] == fixed_route["provider"] and
                  route["model"] == fixed_route["model"]]
        if not routes:
            raise bad("原参考视频服务或模型已变更，请重新配置后再重试")
    motion = await resolve_previs_guide(user,raw) if raw.get("previs_guide") is not None else None
    first_error = None
    for route in routes:
        provider, model = route["provider"], route["model"]
        entries = {key:copy.deepcopy(raw[key]) for key in ("audio_refs","video_refs") if raw.get(key)}
        candidate = {**raw,**entries}
        try:
            reference_video_duration(candidate,provider,model,motion)
            checked_video_resolution(candidate,provider["kind"],model,provider=provider)
            if candidate.get("draft") and not remote.supports_video_draft(provider,model):
                raise bad("请选择支持原生样片的 Seedance 2.5 服务")
            clips,audio = await check_reference_inputs(user,candidate,provider,model,motion,object_plan)
        except web.HTTPBadRequest as exc:
            if first_error is None:
                first_error = exc
            continue
        for key, value in entries.items():
            kind = "video" if key=="video_refs" else "audio"
            resolved = {(before["ref"],before.get("start"),before.get("end")):after
                        for before,after in zip(raw[key],value)}
            for asset in raw.get("memory_used", []):
                for reference in asset.get("references", []):
                    if reference.get("type") == kind:
                        match = resolved.get((reference["ref"],reference.get("start"),reference.get("end")))
                        if match:
                            reference.update(start=match["start"],end=match["end"])
            raw[key][:] = value
        return route, motion, clips, audio
    raise first_error


def reference_preview_fingerprint(raw, route, *, guide_frames=False):
    snapshot = workflow_review.capture_generation(raw)
    if not guide_frames:
        if plan := resolve_camera_plan(raw):
            snapshot["camera_plan"] = plan
        if plan := resolve_object_edit(raw):
            snapshot["object_edit"] = plan
    provider = route["provider"]
    prompt = (remote_video_prompt(raw,provider,route["model"])[0] if guide_frames
              else video_reference_prompt(raw,provider,route["model"]))
    details = [raw.get("board"),provider["id"],provider.get("updated"),route["model"],prompt,
               snapshot,raw.get("draft")]
    return hashlib.sha256(json.dumps(details,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def needs_reference_review(raw):
    return has_asset_media(raw) or (not raw.get("provider") and raw.get("selected_model") is None and
        any(raw.get(key) for key in ("previs_guide","video_refs","audio_refs")))


def verify_reference_preview(req, raw, route, *, guide_frames=False):
    reviewable = (has_remote_image_references(raw,route) if guide_frames else
                  bool(route and raw.get("kind")=="video" and any(raw.get(k) for k in ("previs_guide","video_refs","audio_refs"))))
    key = req.get("reference_preview")
    confirmed = req.get("reference_reviewed")
    # Older assistant approvals for explicitly selected services did not store a preview key.
    if not key and not (confirmed and reviewable and (guide_frames or needs_reference_review(raw))):
        return
    if not reviewable or key != reference_preview_fingerprint(raw,route,guide_frames=guide_frames):
        next_step = "重新确认生成" if confirmed else "重新预览"
        reason = "参考素材或生成服务已变化" if reviewable else "参考素材已变化"
        creative_memory.fail(f"{reason}，请{next_step}",409)


@routes.post("/api/video/reference-models")
async def video_reference_models(req):
    raw = await req.json()
    if (not isinstance(raw,dict) or raw.get("kind") != "video" or not isinstance(raw.get("board"),str)
            or not isinstance(raw.get("prompt",""),str) or not isinstance(raw.get("fields",{}),dict)
            or any(not isinstance(raw.get(key,[]),list) or any(not isinstance(item,dict) for item in raw.get(key,[]))
                   for key in ("images","audio_refs","video_refs"))):
        raise bad("视频参考设置无效")
    user = req["user"]
    board = board_meta(board_path(raw["board"]))
    if not board or not can_edit(user,board):
        raise web.HTTPForbidden()
    payload = req.app["creative_memory"].prepare(user,raw,replay_ref=checked_asset_replay(raw),video_reference_check=True)
    check_reference_operation(payload)
    motion = await resolve_previs_guide(user,payload) if payload.get("previs_guide") is not None else None
    resolve_camera_plan(payload)
    object_plan = resolve_object_edit(payload)
    image_only = not (motion or payload.get("video_refs") or payload.get("audio_refs"))
    if image_only and not wants_image_references(payload):
        return web.json_response({"models":[],"message":"当前使用普通文生视频或原生首尾帧。可在节点设置直接选择模型。"})
    resolve_video_reference_images(user,payload)
    routes = reference_routes(require_motion=bool(motion or payload.get("video_refs")),
                              segment_edit=bool(payload.get("segment_edit")),extension=bool(payload.get("extension")),
                              all_models=True,image_only=image_only)
    requested_quality = payload.get("quality")
    requested_quality = requested_quality if isinstance(requested_quality,str) and requested_quality else "hd"
    try:
        duration = image_editor.number(payload.get("duration"),0,300,"成片时长",5)
    except ValueError as exc:
        raise bad(str(exc)) from None
    results, defaults = [], {}
    for route in routes:
        provider,model = route["provider"],route["model"]
        defaults.setdefault(provider["id"],model)
        choice = canvas_model_choice(provider,"video",model)
        durations = choice["durations"]
        if motion and not payload.get("extension"):
            durations = [seconds for seconds in durations if seconds <= 14]
        seconds = min(durations,key=lambda value:abs(value-round(duration)))
        draft = bool(payload.get("draft")) and choice["draft"]
        quality = "std" if draft or requested_quality not in choice["qualities"] else requested_quality
        row = {"provider_id":provider["id"],"provider":provider["name"],"model":model,
               **({"endpoint_model":choice["endpoint_model"]} if "endpoint_model" in choice else {}),
               "duration":seconds,"quality":quality,"resolution":"480p" if draft else choice["qualities"][quality],
               "draft":draft,"limits":choice["reference_limits"],"selected":raw.get("provider")==provider["id"]
               and model==(raw.get("selected_model") or defaults[provider["id"]])}
        candidate = copy.deepcopy(payload)
        try:
            clips,audio = await check_reference_inputs(user,candidate,provider,model,motion,object_plan)
            row["video_seconds"] = round((sum(clip["ticks"] for clip in clips) + (motion["ticks"] if motion else 0))/film.FPS,2)
            row["audio_seconds"] = round(sum(seconds for _,_,seconds in audio),2)
            if payload.get("segment_edit"):
                source = candidate["video_refs"][0]
                row["duration"] = round(source["end"]-source["start"],2)
        except web.HTTPBadRequest as error:
            row["error"] = json.loads(error.text)["error"]
        results.append(row)
    counts = {"images":len(payload.get("images") or []) + (1 + bool(object_plan.get("replacement_ref")) if object_plan else 0),
              "videos":len(payload.get("video_refs") or []) + bool(motion),"audio":len(payload.get("audio_refs") or [])}
    message = "" if results else "当前没有支持这些参考类型的视频服务，请在控制台检查配置。"
    return web.json_response({"models":results,"counts":counts,"message":message,"image_only":image_only})


async def describe_video_references(user,payload,object_plan):
    check_reference_operation(payload)
    resolve_video_reference_images(user,payload)
    route, motion, clips, _ = await prepare_reference_generation(user,payload,object_plan)
    model, provider = route["model"],route["provider"]
    seconds = reference_video_duration(payload,provider,model,motion)
    if payload.get("segment_edit") and payload.get("video_refs"):
        source = payload["video_refs"][0]
        seconds = round(source["end"]-source["start"],2)
    quality = checked_video_resolution(payload,provider["kind"],model,provider=provider)
    model_for_limits = motion_reference.video_model_for_limits(provider,model)
    limit = motion_reference.av_limits(model_for_limits)[0]
    counts = (("图",len(payload.get("images") or []),motion_reference.image_limit(model_for_limits)),
              ("视频",len(payload.get("video_refs") or [])+bool(motion),limit),
              ("音频",len(payload.get("audio_refs") or []),limit))
    inputs = numbered_reference_inputs(workflow_review.capture_generation(payload)["inputs"],payload,
                                       h3_labels=is_cloud_h3(provider,model))
    input_video_seconds = (sum(clip["ticks"] for clip in clips) + (motion["ticks"] if motion else 0))/film.FPS
    return {"provider":provider["name"],"model":model,"duration":seconds,"quality":quality,
            "prompt":video_reference_prompt(payload,provider,model),
            "counts":counts,"inputs":inputs,"assets":[item["name"] for item in payload.get("memory_used",[])],
            "key":reference_preview_fingerprint(payload,route),
            "unit_cost":quoted_video_unit_cost(route,payload,seconds,input_video_seconds=input_video_seconds)}


async def asset_reference_review(req,raw,*,replay_ref=None):
    replay_ref = replay_ref or req.get("replay_memory_ref")
    fields = raw.get("fields")
    prompt = raw.get("prompt", "")
    if not isinstance(prompt, str) or fields is not None and not isinstance(fields, dict):
        raise bad("提示词格式不正确")
    has_mention = any(isinstance(part,str) and "@" in part for part in [prompt,*(fields or {}).values()])
    payload = raw
    if replay_ref or has_mention or any(raw.get(key) for key in ("memory_ids","memory_views","video_refs","audio_refs","previs_guide")):
        payload = apply_video_optics(req.app["creative_memory"].prepare(req["user"],raw,replay_ref=replay_ref,
            owner_only=bool(req.get("connector_own_assets"))))
    if any(payload.get(key) for key in ("previs_guide","video_refs","audio_refs")):
        review = await describe_video_references(req["user"],payload,resolve_object_edit(payload))
        return review,review["unit_cost"]
    route = requested_generation_route(payload,"video")
    provider = route["provider"] if route else None
    maximum = (remote.video_durations(provider["kind"],route["model"],provider=provider)[-1]
               if provider and provider["kind"]!="local_h3" else 15)
    duration = payload.get("duration")
    if type(duration) in (int,float) and duration > maximum:
        raise bad(f"此模式成片最长 {maximum} 秒")
    if has_remote_image_references(payload,route):
        provider,model = route["provider"],route["model"]
        _, roles = remote_video_prompt(payload,provider,model)
        resolve_video_reference_images(req["user"],payload)
        inputs = numbered_reference_inputs(workflow_review.capture_generation(payload)["inputs"],payload,
                                           h3_labels=is_cloud_h3(provider,model))
        for entry,role in zip(inputs,roles):
            set_video_preview_image_role(entry,role)
        seconds = reference_video_duration(payload,provider,model,None)
        quality = checked_video_resolution(payload,provider["kind"],model,provider=provider)
        limit = image_reference_limit(payload,provider,model)
        cost = quoted_video_unit_cost(route,payload,seconds)
        return {"provider":provider["name"],"model":model,"duration":seconds,"quality":quality,
                "counts":[("图",len(inputs),limit)],"inputs":inputs,"assets":[item["name"] for item in payload.get("memory_used",[])],
                "key":reference_preview_fingerprint(payload,route,guide_frames=True),"unit_cost":cost},cost
    quote = {key:value for key,value in payload.items()
             if key not in ("memory_ids","memory_views","has_asset","prompt","fields")}
    return None,generation_unit_cost(quote)


def previs_routes():
    return reference_routes(require_motion=True)


def resolve_camera_plan(raw):
    if "camera_plan" not in raw:
        return None
    if raw.get("segment_edit") is not True or not raw.get("video_refs") or raw.get("extension"):
        raise bad("镜头重拍需要指定原视频片段")
    try:
        return camera_plan.validate(raw["camera_plan"])
    except ValueError as error:
        raise bad(str(error)) from None


def apply_video_optics(raw):
    if "video_optics" not in raw:
        return raw
    if raw.get("kind","video") != "video":
        raise bad("视频镜头参数仅用于视频生成")
    try:
        settings = image_camera.validate_optics(raw["video_optics"])
    except ValueError as error:
        raise bad(str(error)) from None
    if not settings:
        return raw
    description = "，".join(image_camera.optics_instructions(settings)) + "。"
    fields = raw.get("fields")
    if isinstance(fields,dict) and pfields.has_content(fields):
        camera = str(fields.get("camera") or "").strip()
        return {**raw,"fields":{**fields,"camera":"\n".join(filter(None,(camera,description)))}}
    prompt = str(raw.get("prompt") or "").strip()
    prompt, structured = _append_to_section(prompt,("detailed_description","integrated_multimodal_description"),description)
    return {**raw,"prompt":prompt if structured else "\n".join(filter(None,(prompt,description)))}


def resolve_object_edit(raw):
    if "object_edit" not in raw:
        return None
    if raw.get("segment_edit") is not True or not raw.get("video_refs") or raw.get("camera_plan") or raw.get("extension"):
        raise bad("物体编辑需要指定原视频片段")
    try:
        return object_edit.validate(raw["object_edit"])
    except ValueError as error:
        raise bad(str(error)) from None


def numbered_reference_inputs(inputs, payload, *, h3_labels=False):
    image_count = len(payload.get("images") or [])
    pictures, media = inputs[:image_count],inputs[image_count:]
    guide = next((item for item in media if item.get("role")=="previs"),None)
    videos = motion_reference.ordered_video_references(guide,(item for item in media if item.get("role")=="video_ref"),
                    source_first=bool(payload.get("extension") or payload.get("segment_edit")))
    audio = [item for item in media if item.get("role")=="audio_ref"]
    for prefix,group in (("图片",pictures),("视频",videos),("音频",audio)):
        for index,item in enumerate(group,1):
            item["prompt_reference"] = (video_prompt_adapters.h3_reference_label(prefix,index) if h3_labels
                                        else f"@{prefix}{index}")
    return pictures + videos + audio


def set_video_preview_image_role(item, role):
    if role=="image_ref" and item.get("role") in ("subject","frame"):
        item["image_role"] = item["role"]
    item["role"] = role


def is_cloud_h3(provider, model):
    return provider["kind"] == "minimax" and model in motion_reference.H3_CLOUD_MODELS


def video_reference_prompt(raw, provider, model, *, guide_frames=False):
    prompt = reference_prompt(raw,guide_frames=guide_frames)
    if is_cloud_h3(provider,model):
        return video_prompt_adapters.h3_cloud_prompt(prompt,images=raw.get("images") or [],reference=True)
    return prompt


def reference_prompt(raw, *, guide_frames=False):
    retake = resolve_camera_plan(raw)
    object_plan = resolve_object_edit(raw)
    prompt = plain_prompt(raw)
    if not prompt and not retake and not object_plan:
        raise bad("请描述正式视频的内容或画面风格")
    prompt = video_prompt_adapters.map_reference_tokens(
        prompt,lambda kind,number: "@"+{"图":"图片","音":"音频"}.get(kind,kind)+number)
    images = raw.get("images") or []
    frames = [(i,entry) for i,entry in enumerate(images,1)
              if entry.get("role")=="frame" or guide_frames and entry.get("role")!="subject"]
    if frames:
        guidance = []
        duration = raw.get("duration")
        for index,(i,entry) in enumerate(frames):
            at = entry.get("time")
            if raw.get("planned") and isinstance(at,(int,float)) and 0 <= at <= 30:
                position = ("开头" if at <= .01 else "结尾"
                            if isinstance(duration,(int,float)) and at >= duration-.25 else f"约在 {at:g} 秒")
            elif index==0:
                position = "开头"
            elif index==len(frames)-1:
                position = "结尾"
            elif isinstance(at,(int,float)) and 0 < at <= 30:
                position = f"约在 {at:g} 秒"
            else:
                continue
            guidance.append(f"{position}参考 @图片{i} 的构图。")
        if any(is_character_reference(image) for image in images):
            guidance.append("关键帧里出现的人物与各自的角色参考图共用同一身份。除非镜头明确要求分身，同一角色同时只出现一位。")
        prompt = "".join(guidance) + "\n" + prompt
    extension = raw.get("extension")
    edit = raw.get("segment_edit")
    if raw.get("previs_guide"):
        n = 2 if extension or edit else 1
        guidance = "人物走位和空间关系，机位服从重拍方案。" if retake else "镜头运动、人物走位和空间构图。"
        prompt = (f"参考 @视频{n} 的{guidance}"
                  "按描述和参考图生成正式画面，使用正式场景的材质、光线和色彩。\n" + prompt)
    if extension in ("before","after"):
        direction = "向前" if extension=="before" else "向后"
        boundary = "开头之前" if extension=="before" else "结尾之后"
        prompt = (f"{direction}延长 @视频1。只生成接在原视频{boundary}的新片段。"
                  "让人物外观、场景、光线和动作在接点自然衔接。\n" + prompt)
    if object_plan:
        prompt = (object_edit.instructions(object_plan,len(raw.get("images") or [])+1)+"\n"+prompt).strip()
    elif retake:
        direction = camera_plan.instructions(retake)
        prompt = ("按下列机位方案重拍 @视频1。保留人物外观、原场景、动作内容和发生顺序。"
                  f"保持原片段的时长和画幅。{direction}\n{prompt}").strip()
    elif edit:
        prompt = ("编辑 @视频1 中指定的内容，保留其他人物、场景和镜头节奏。保持原片段的时长和画幅。\n" + prompt)
    return prompt


def has_asset_media(raw):
    return any(isinstance(entry,dict) and entry.get("memory_id") for key in ("audio_refs","video_refs")
               for entry in (raw.get(key) if isinstance(raw.get(key),list) else []))


def is_asset_media(raw, entry):
    if not isinstance(entry,dict) or not entry.get("memory_id"):
        return False
    return any(asset["id"] == entry["memory_id"] and any(item.get("ref") == entry.get("ref")
               for item in asset.get("references",[])) for asset in raw.get("memory_used",[]))


async def resolve_audio_refs(user, raw, model, *, provider_kind="ark"):
    limit, max_seconds = motion_reference.av_limits(model)
    entries = raw["audio_refs"]
    if not isinstance(entries, list) or len(entries) > limit:
        raise bad(f"此服务最多可采用 {limit} 段参考音频")
    board = board_meta(board_path(raw.get("board")))
    if not board or not can_edit(user, board):
        return_error = json.dumps({"error":"需要画布编辑权限才能提交参考音频"}, ensure_ascii=False)
        raise web.HTTPForbidden(text=return_error, content_type="application/json")
    nodes = {n["id"]:n for n in board.get("nodes", []) if n.get("type") == "audio"}
    result = []
    for entry in entries:
        ref, nid = (entry.get("ref"), entry.get("node_id")) if isinstance(entry, dict) else (None, None)
        if (not isinstance(ref, str) or not (is_asset_media(raw,entry) or isinstance(nid,str) and
                any(v.get("ref") == ref for v in nodes.get(nid, {}).get("versions", [])))):
            raise bad("音频参考版本已移除或尚未保存，请重新选择")
        try:
            path = tools.ref_path(COMFY_DIR, ref)
        except ValueError:
            raise bad("音频素材格式无效") from None
        if path.suffix.lower() not in AUDIO_MEDIA_EXT:
            raise bad("请选择音频文件作为参考")
        require_media(user, {ref})
        try:
            seconds = await asyncio.to_thread(film.audio_duration, path)
        except (OSError, ValueError):
            raise bad("音频文件无法读取") from None
        try:
            start = image_editor.number(entry.get("start"),0,seconds,"音频参考入点",0)
            end = min(seconds,image_editor.number(entry.get("end"),start,seconds+.025,"音频参考出点",seconds))
        except ValueError as exc:
            raise bad(str(exc)) from None
        duration = end-start
        if not 2-1e-8 <= duration <= max_seconds+.05:
            raise bad(f"每段参考音频须为 2 到 {max_seconds} 秒")
        duration = min(duration,max_seconds)
        result.append((path,start,duration))
        entry.update(start=start,end=round(start+duration,5))
    if sum(seconds for _,_,seconds in result) > max_seconds + .05:
        raise bad(f"参考音频总时长不能超过 {max_seconds} 秒")
    if provider_kind == "ark" and max_seconds == 15 and not raw.get("images") and not raw.get("previs_guide") and not raw.get("video_refs"):
        raise bad("此服务需要同时连入参考图或参考视频")
    return result


async def resolve_previs_guide(user, raw):
    guide = raw["previs_guide"]
    if not isinstance(guide, dict):
        raise bad("白模动作参考格式无效")
    ref, nid = guide.get("ref"), guide.get("node_id")
    if (not isinstance(ref, str) or not re.fullmatch(r"output:h3studio/previs_\d{8}_\d{6}_[a-f0-9]{5}\.mp4", ref)
            or not isinstance(nid, str)):
        raise bad("请选择已渲染的白模预演版本")
    board = board_meta(board_path(raw.get("board")))
    if not board or not can_edit(user, board):
        raise web.HTTPForbidden(text=json.dumps({"error":"需要画布编辑权限才能提交白模动作参考"}, ensure_ascii=False),
                                content_type="application/json")
    node = next((n for n in board.get("nodes", []) if n.get("id") == nid and n.get("type") == "video"), None)
    if not node or not any(v.get("source") == "previs" and v.get("ref") == ref for v in node.get("versions", [])):
        raise bad("白模预演版本已移除或尚未保存，请重新选择")
    require_media(user, {ref})
    path = tools.ref_path(COMFY_DIR, ref)
    try:
        w, h, seconds, _ = await asyncio.to_thread(film.probe, path, display=False)
        ticks = round(seconds * film.FPS)
    except (OSError, ValueError, IndexError):
        raise bad("白模预演文件无法读取，请重新渲染") from None
    if not motion_reference.eligible(w, h, ticks) or ticks > previs.MAX_SECONDS * film.FPS:
        raise bad("白模预演时长或画幅超出动作参考范围")
    return {"path":path, "ticks":ticks, "source":"previs"}


async def resolve_video_refs(user, raw, model, motion):
    limit, max_seconds = motion_reference.av_limits(model)
    entries = raw["video_refs"]
    if not isinstance(entries, list) or len(entries) + bool(motion) > limit:
        raise bad(f"此服务最多可采用 {limit} 段参考视频（包含白模）")
    board = board_meta(board_path(raw.get("board")))
    if not board or not can_edit(user, board):
        raise web.HTTPForbidden(text=json.dumps({"error":"需要画布编辑权限才能提交参考视频"}, ensure_ascii=False),
                                content_type="application/json")
    nodes = {n["id"]:n for n in board.get("nodes", []) if n.get("type") == "video"}
    clips = []
    for index, entry in enumerate(entries):
        ref, nid = (entry.get("ref"), entry.get("node_id")) if isinstance(entry, dict) else (None, None)
        if (not isinstance(ref, str) or not (is_asset_media(raw,entry) or isinstance(nid,str) and
                any(v.get("ref") == ref for v in nodes.get(nid, {}).get("versions", [])))):
            raise bad("参考视频版本已移除或尚未保存，请重新选择")
        require_media(user, {ref})
        try:
            path = tools.ref_path(COMFY_DIR, ref)
            if path.suffix.lower() not in tools.VIDEO_EXT:
                raise ValueError()
            w, h, seconds, _ = await asyncio.to_thread(film.probe, path)
            if not w or not h or not .4 <= w / h <= 2.5:
                raise ValueError()
        except (OSError, ValueError, IndexError):
            raise bad("参考视频无法读取，或宽高比超出 0.4 到 2.5") from None
        extension = raw.get("extension") if index==0 else None
        edit = raw.get("segment_edit") and index==0
        default_start = max(0,seconds-4) if extension=="after" else 0
        try:
            start = image_editor.number(entry.get("start"), 0, seconds, "视频参考入点", default_start)
            default_end = seconds if extension=="after" or is_asset_media(raw,entry) else min(seconds,start+(4 if extension=="before" else max_seconds))
            end = min(seconds, image_editor.number(entry.get("end"), start, seconds + .025, "视频参考出点",
                                                   default_end))
        except ValueError as exc:
            raise bad(str(exc)) from None
        if (extension=="before" and start > .025) or (extension=="after" and seconds-end > .025):
            raise bad("续拍参考须包含原片接点，请保留片头或片尾")
        if extension=="before":
            start=0
        elif extension=="after":
            end=seconds
        if edit:
            start=round(start*film.FPS)/film.FPS
            end=min(seconds,round(end*film.FPS)/film.FPS)
        minimum = 4 if edit else 2
        ticks = round((end-start) * film.FPS)
        if not film.FPS * minimum <= ticks <= max_seconds * film.FPS:
            if is_asset_media(raw,entry):
                raise bad(f"资产「{entry['name']}」的参考视频须为 {minimum} 到 {max_seconds} 秒")
            raise bad(f"待编辑片段须为 {minimum} 到 {max_seconds} 秒" if edit else f"每段参考视频须为 2 到 {max_seconds} 秒")
        clips.append({"path":path, "start":start, "ticks":ticks, "ratio":w / h, "source_seconds":seconds})
    if sum(clip["ticks"] for clip in clips) + (motion["ticks"] if motion else 0) > max_seconds * film.FPS:
        raise bad(f"参考视频总时长不能超过 {max_seconds} 秒（包含白模）")
    for entry, clip in zip(entries, clips):
        entry.update(start=clip["start"], end=min(clip["source_seconds"],round(clip["start"]+clip["ticks"]/film.FPS, 5)))
    if raw.get("segment_edit"):
        entries[0]["source_seconds"] = clips[0]["source_seconds"]
    return clips


def media_info(path: Path, kind: str) -> dict:
    try:
        if kind == "video":
            w, h, dur, _ = film.probe(path)
            return {"width": w, "height": h, "duration": round(dur, 2)}
        if kind == "image":
            from PIL import Image
            with Image.open(path) as im:
                return {"width": im.width, "height": im.height}
        if kind == "audio":
            return {"duration":film.audio_duration(path)}
    except Exception:
        pass
    return {}


def resolve_video_reference_images(user, raw):
    images = raw.get("images") or []
    if not isinstance(images,list) or any(not isinstance(image,dict) or not isinstance(image.get("ref"),str)
                                          for image in images):
        raise bad("请选择可读取的参考图")
    refs = [image["ref"] for image in images]
    require_media(user,set(refs))
    try:
        paths = [tools.ref_path(COMFY_DIR,ref) for ref in refs]
    except ValueError:
        raise bad("请选择可读取的参考图") from None
    if any(path.suffix.lower() not in creative_memory.IMAGE_EXT or not path.is_file() for path in paths):
        raise bad("参考图无法读取，请重新选择")
    return paths


def ensure_reference_media_count(raw, provider_kind, model, object_plan):
    limit = motion_reference.image_limit(model)
    extra = (1 + bool(object_plan.get("replacement_ref"))) if object_plan else 0
    if len(raw.get("images") or []) + extra > limit:
        raise bad(f"此服务最多支持 {limit} 张有效参考图")
    if provider_kind == "minimax":
        total = sum(len(raw.get(key) or []) for key in ("images","audio_refs","video_refs")) + bool(raw.get("previs_guide"))
        if total > 12:
            raise bad("云端 H3 的图片、视频和音频参考合计最多 12 项")


async def generate_remote(req, raw: dict, route: dict, cap: str, *, motion=None, audio_refs=(), video_refs=()):
    """Run one image / video request on a third-party provider; tracked in JOBS like a local job (id "x…")."""
    p, model = route["provider"], route["model"]
    u = req["user"]
    resolution = checked_video_resolution(raw,p["kind"],model,provider=p) if cap=="video" else None
    draft = raw.get("draft")
    if draft and (draft is not True or cap != "video" or not remote.supports_video_draft(p,model)):
        raise bad("请选择支持原生样片的 Seedance 2.5 服务")
    from_previs = motion and motion.get("source") == "previs"
    object_plan = raw.get("object_edit")
    full_reference = from_previs or audio_refs or video_refs
    image_references = cap == "video" and not full_reference and image_reference_limit(raw,p,model)
    if full_reference:
        prompt = video_reference_prompt(raw,p,model)
    elif cap == "video":
        prompt, _ = remote_video_prompt(raw, p, model)
    else:
        prompt = plain_prompt(raw)
    if not prompt:
        raise bad("提示词不能为空")
    imgs = []
    if not (full_reference or image_references):
        for im in raw.get("images") or []:
            try:
                imgs.append({**im, "path": tools.ref_path(COMFY_DIR, im["ref"])})
            except Exception:
                pass
    if cap == "image":
        nreq = {"prompt": re.sub(r"@图(\d+)", r"图\1", prompt), "images": [x["path"] for x in imgs], "ar": float(raw.get("ar") or 1), "n": int(raw.get("count") or 1)}
    elif full_reference or image_references:
        model_for_limits = motion_reference.video_model_for_limits(p,model)
        ensure_reference_media_count(raw,p["kind"],model_for_limits,object_plan)
        paths = resolve_video_reference_images(u,raw)
        try:
            seconds = reference_video_duration(raw,p,model,motion)
            ratio = image_editor.number(raw.get("ar"), .4, 2.5, "画面宽高比", 16 / 9)
        except ValueError as exc:
            raise bad(str(exc))
        nreq = {"prompt":prompt, "first":None, "last":None, "refs":paths,
                "duration":seconds, "ar":ratio,
                "quality":raw.get("quality") or "hd", "audio":True, "audio_refs":audio_refs}
        if raw.get("extension"):
            nreq["extension"] = raw["extension"]
        if raw.get("segment_edit"):
            nreq["segment_edit"] = True
        if object_plan:
            clip = video_refs[0]
            if not clip["start"] <= object_plan["at"] < min(clip["source_seconds"], clip["start"] + clip["ticks"]/film.FPS):
                raise bad("物体标注帧须位于要修改的区间内")
            nreq["object_edit"] = object_plan
            if ref := object_plan.get("replacement_ref"):
                require_media(u, {ref})
                try:
                    path = tools.ref_path(COMFY_DIR, ref)
                    if path.suffix.lower() not in (".png",".jpg",".jpeg",".webp") or not path.is_file():
                        raise ValueError()
                except ValueError:
                    raise bad("请选择可读取的替换参考图") from None
                nreq["replacement_path"] = path
    else:
        frames = [x for x in imgs if x.get("role") != "subject"]
        nreq = {"prompt": prompt, "first": frames[0]["path"] if frames else None, "last": frames[-1]["path"] if len(frames) > 1 else None,
                "refs": [x["path"] for x in imgs if x.get("role") == "subject"], "duration": float(raw.get("duration") or 5),
                "ar": float(raw.get("ar") or 16 / 9), "quality": raw.get("quality") or "hd", "audio": True}
    if motion or video_refs:
        if cap != "video" or not motion_reference.supports(p, model) or nreq["first"] is not None:
            raise bad("此服务或参考素材不能用于动作参考")
        if motion and not from_previs:
            if not nreq["refs"]:
                raise bad("深度参考需要已采用的首帧图")
            nreq.update(audio=False)
    if draft:
        nreq["draft"] = True
    cls = f"remote|{p['kind']}|{cap}|{model}"
    count = 1 if cap == "image" else max(1, min(3, int(raw.get("count") or 1)))
    ids = []
    for _ in range(count):
        jid = "x" + uuid.uuid4().hex[:12]
        meta = {"label": clean(raw.get("label"))[:60] or p["name"], "cls": cls, "units": 1, "est": estimate(cls, 1, 40 if cap == "image" else 150),
                "mode_name": f"{p['name']} · {model}", "uid": u["id"], "provider": p["name"], "model":model,
                "prompt": prompt, "board":clean(raw.get("board"))}
        if resolution:
            meta["resolution"] = resolution
        if raw.get("segment_edit"):
            operation = object_edit.ACTIONS[object_plan["action"]] if object_plan else "镜头重拍" if raw.get("camera_plan") else "片段修改"
            meta["mode_name"]=operation+" · "+meta["mode_name"]
        if draft:
            meta["mode_name"]="480p 样片 · "+meta["mode_name"]
        j = JOBS[jid] = {"id": jid, "kind": cap, "state": "queued", "created": time.time(), "meta": meta}
        attach_image_edit(j, raw)
        request_data = {"prompt":prompt[:2000]}
        if resolution:
            request_data["resolution"] = resolution
        if from_previs:
            request_data["previs_ref"] = raw["previs_guide"]["ref"]
        if audio_refs:
            request_data["audio_refs"] = [{key:entry[key] for key in ("ref","start","end") if key in entry}
                                          for entry in raw["audio_refs"]]
        if video_refs:
            request_data["video_refs"] = [{k:entry[k] for k in ("ref","start","end") if k in entry} for entry in raw["video_refs"]]
        if raw.get("extension"):
            request_data["extension"] = raw["extension"]
        if raw.get("segment_edit"):
            request_data["segment_edit"] = True
        if raw.get("camera_plan"):
            request_data["camera_plan"] = raw["camera_plan"]
        if object_plan:
            request_data["object_edit"] = object_plan
        if draft:
            request_data["draft"] = True
        db.task_start(id=jid, user_id=u["id"], board_id=meta["board"], label=meta["label"], capability=cap, provider_id=p["id"],
                      provider_kind=p["kind"], model=model, state="queued", request=request_data)
        start_remote(req.app, j, p, model, cap, nreq, motion=motion, video_refs=video_refs)
        ids.append(jid)
    return web.json_response({"ids": ids, "meta": JOBS[ids[0]]["meta"]})


def video_draft_source(ref):
    return db.one("SELECT d.provider_task,d.expires,t.provider_id,t.model FROM video_drafts d "
                  "JOIN tasks t ON t.id=d.job_id WHERE d.ref=? AND t.state='done'", ref)


@routes.post("/api/video/draft/finalize")
async def finalize_video_draft(req):
    raw = await req.json()
    if not isinstance(raw, dict):
        raise bad("请选择样片和定稿分辨率")
    bid, nid, ref, resolution, key = (raw.get(field) for field in ("board","node","ref","resolution","request_key"))
    if (not all(isinstance(value, str) for value in (bid,nid,ref,key)) or
            not _ID.fullmatch(nid) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}", key) or resolution not in ("1080p","4k")):
        raise bad("请选择样片和定稿分辨率")
    user = req["user"]
    board = board_meta(board_path(bid))
    if not board or not can_edit(user, board):
        raise web.HTTPForbidden()
    node = next((n for n in board["nodes"] if n["id"] == nid and n["type"] == "video"), None)
    if not node or not any(v.get("ref") == ref for v in node.get("versions", [])):
        raise bad("画布里的样片版本已移除")
    require_media(user, {ref})
    jid = "r" + hashlib.sha256(f"draft-final:{user['id']}:{key}".encode()).hexdigest()[:24]
    fingerprint = {"board":bid,"node":nid,"ref":ref,"resolution":resolution}
    if existing := db.one("SELECT request FROM tasks WHERE id=?", jid):
        saved = task_settings(existing["request"])
        if any(saved.get(field) != value for field, value in fingerprint.items()):
            raise bad("该定稿请求已经用于另一项任务")
        return web.json_response({"ids":[jid],"meta":JOBS.get(jid, {}).get("meta", {})})
    source = video_draft_source(ref)
    if not source:
        raise bad("这个视频版本没有可用的样片任务")
    if source["expires"] <= time.time():
        raise bad("样片已过定稿有效期，请重新生成样片")
    provider = providers.get(source["provider_id"])
    if not provider or not provider["enabled"] or not remote.supports_video_draft(provider,source["model"]):
        raise bad("原样片的 Seedance 服务不可用")
    model = source["model"]
    label = (node["name"] + " · " + resolution.upper() + " 定稿")[:60]
    cls = f"remote|ark|video|{model}|final|{resolution}"
    meta = {"label":label,"cls":cls,"units":1,"est":estimate(cls,1,150),"board":bid,"uid":user["id"],
            "mode_name":resolution.upper()+" 定稿","provider":provider["name"],"model":model,"resolution":resolution}
    db.task_start(id=jid,user_id=user["id"],board_id=bid,label=label,capability="video",provider_id=provider["id"],
                  provider_kind="ark",model=model,request={**fingerprint,"history":video_job_details(meta)})
    job = JOBS[jid] = {"id":jid,"kind":"video","state":"queued","created":time.time(),"meta":meta}
    start_remote(req.app,job,provider,model,"video",
                 {"draft_task":source["provider_task"],"resolution":resolution})
    return web.json_response({"ids":[jid],"meta":meta})


REMOTE_SEM: dict = {}


def start_remote(app, *args, **kwargs):
    task = asyncio.create_task(run_remote(app, *args, **kwargs))
    tasks = app.get("remote_tasks")
    if tasks is not None:
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    return task


def record_remote_video(job, receipt):
    row = db.one("SELECT request FROM tasks WHERE id=?", job["id"])
    request = task_settings(row["request"])
    request.update(remote_video=receipt, history=video_job_details(job["meta"]))
    fields = {"request":json.dumps(request, ensure_ascii=False)}
    if not job.get("cancel"):
        fields.update(state="running", started=job["started"])
    db.task_update(job["id"], **fields)


async def run_with_motion(app, j, p, model, nreq, motion, video_refs=(), *, on_submitted=None):
    origin = motion_reference.public_origin(p["config"].get("motion_origin"))
    with tempfile.TemporaryDirectory(prefix="oneshot-motion-") as temp, ExitStack() as leases:
        j["phase"] = "encoding"
        cancelled = lambda: j.get("cancel")
        paths = []
        if motion:
            path = Path(temp) / "guide.mp4"
            await asyncio.to_thread(motion_reference.prepare, motion["path"], path, motion["ticks"], cancelled)
            paths.append(path)
        for i, clip in enumerate(video_refs):
            if cancelled():
                return None
            path = Path(temp) / f"reference-{i}.mp4"
            await asyncio.to_thread(motion_reference.prepare_clip, clip["path"], path, clip["start"], clip["ticks"], clip["ratio"], cancelled)
            paths.append(path)
        if cancelled():
            return None
        def publish(path):
            return leases.enter_context(motion_reference.publish(origin,path,lambda:j["state"] == "running" and not cancelled()))
        urls = [publish(path) for path in paths]
        request = {**nreq, "motion_url":urls[0] if motion else None, "video_urls":urls[bool(motion):]}
        if p["kind"] == "minimax":
            audio_urls = []
            for index,(source,start,seconds) in enumerate(nreq.get("audio_refs",[])):
                if cancelled():
                    return None
                path = Path(temp) / f"reference-audio-{index}.wav"
                data = await asyncio.to_thread(remote.reference_audio_wav,source,seconds,start)
                path.write_bytes(data)
                audio_urls.append(publish(path))
            request["audio_urls"] = audio_urls
            urls += audio_urls
        j["phase"] = "sampling"
        try:
            if plan := nreq.get("object_edit"):
                guide = Path(temp) / "selection.png"
                await asyncio.to_thread(object_edit.annotate, video_refs[0]["path"], guide, plan)
                request["refs"] = [*nreq["refs"],guide]
                if replacement := nreq.get("replacement_path"):
                    request["refs"].append(replacement)
                if cancelled():
                    return None
            return await remote.run(app["http"], COMFY_DIR, p, model, "video", request, on_submitted=on_submitted)
        except Exception as exc:
            message = str(exc)
            for url in urls:
                message = message.replace(url, "素材参考链接").replace(url.rsplit("/", 1)[-1], "已隐藏")
            raise providers.ProviderError(message) from None


async def run_remote(app, j: dict, p: dict, model: str, cap: str, nreq: dict, *, motion=None, video_refs=(), receipt=None):
    sem = REMOTE_SEM.setdefault(p["id"], asyncio.Semaphore(3))       # be polite to each provider
    async with sem:
        if j.get("cancel"):
            return
        j["state"] = "running"
        j.setdefault("started", time.time())
        try:
            if receipt is not None:
                r = await remote.resume_video(app["http"], COMFY_DIR, p, receipt)
            elif cap == "video":
                def submitted(value):
                    record_remote_video(j, value)
                if motion or video_refs or p["kind"] == "minimax" and nreq.get("audio_refs"):
                    r = await run_with_motion(app, j, p, model, nreq, motion, video_refs, on_submitted=submitted)
                else:
                    r = await remote.run(app["http"], COMFY_DIR, p, model, cap, nreq, on_submitted=submitted)
            else:
                r = await remote.run(app["http"], COMFY_DIR, p, model, cap, nreq)
            if r is None or j.get("cancel"):
                return
            outs = []
            for f in r["files"]:
                outs.append({"ref": f["ref"], "url": "/media?ref=" + quote(f["ref"], safe=""), "meta": media_info(f["path"], f["kind"])})
            if j.get("cancel"):
                return
            if r.get("draft_task"):
                expires = r["draft_created"] + 14 * 86400
                for output in outs:
                    db.run("INSERT INTO video_drafts VALUES (?,?,?,?)",
                           output["ref"], j["id"], r["draft_task"], expires)
                    output["extra"] = {"draft_expires":expires}
            db.task_update(j["id"], cost=r.get("cost"), units=r.get("units"))
            await complete_outputs(j, outs)
        except Exception as e:
            if j["state"] != "error":
                message = str(e)
                if receipt is not None:
                    message = re.sub(r"""(?:https?://[^\s"'<>/]*)?""" + motion_reference.LEASE_PATH.pattern,
                                     "视频参考链接", message)
                j.update(state="error", error=message[:500] or e.__class__.__name__)
        log_end(j)


async def tts_remote(req, p: dict, route: dict):
    text = clean(p.get("text"))
    if not text:
        raise bad("先写旁白文字")
    pr = route["provider"]
    jid = "t" + uuid.uuid4().hex[:12]
    t0 = time.time()
    db.task_start(id=jid, user_id=req["user"]["id"], label="配音", capability="tts", provider_id=pr["id"], provider_kind=pr["kind"],
                  model=route["model"], state="running", started=t0, request={"text": text[:500]})
    try:
        r = await remote.run(req.app["http"], COMFY_DIR, pr, route["model"], "tts", {"text": text, "voice": p.get("voice"), "speed": p.get("speed")})
    except Exception as e:
        db.task_update(jid, state="error", error=str(e)[:500], finished=time.time())
        raise bad(f"配音失败：{e}")
    f = r["files"][0]
    db.task_update(jid, state="done", finished=time.time(), seconds=round(time.time() - t0, 1), units=r.get("units"), outputs=[f["ref"]])
    return web.json_response({"ref": f["ref"], "url": "/media?ref=" + quote(f["ref"], safe=""), "seconds": r.get("seconds") or 0, "took": round(time.time() - t0, 1)})


console_routes = web.RouteTableDef()


def canvas_provider_choices(cap, *, enabled=None):
    if enabled is None:
        enabled = [provider for provider in providers.all_providers() if provider["enabled"]]
    rts = providers.routes(cap)
    default = rts[0]["provider"]["id"] if rts else None
    choices = []
    for pr in enabled:
        if cap in providers.caps_of(pr):
            model = providers.default_model(pr,cap)
            local = pr["kind"].startswith("local_")
            choices.append({"id":pr["id"],"name":pr["name"],"kind":pr["kind"],"local":local,
                "model":model,"default":pr["id"]==default,
                **({"default_route_model":rts[0]["model"]} if pr["id"]==default else {}),
                **({"models":[canvas_model_choice(pr,cap,choice) for choice in configured_models(pr,cap,rts)]}
                   if cap=="video" or cap=="image" and not local else {}),
                **({"draft":remote.supports_video_draft(pr,model)} if cap=="video" else {})})
    choices.sort(key=lambda item:(not item["default"],not item["local"]))
    return choices


@console_routes.get("/api/capabilities")
async def capabilities(req):
    """What each node can pick: providers that offer a capability (default first)."""
    enabled = [provider for provider in providers.all_providers() if provider["enabled"]]
    out = {cap:canvas_provider_choices(cap,enabled=enabled) for cap in providers.CAPS}
    route = providers.primary("video")
    out["default_video_draft"] = bool(route and remote.supports_video_draft(route["provider"],route["model"]))
    out["previs"] = canvas_reference_choices(require_motion=True)
    out["video_extension"] = canvas_reference_choices(require_motion=True,extension=True)
    out["audio_reference"] = canvas_reference_choices()
    out["segment_edit"] = canvas_reference_choices(segment_edit=True)
    out["audio_generation"] = {cap:audio_service_options(cap) for cap in AUDIO_GENERATION_MODES}
    out["audio_output"] = film.AUDIO_OUTPUT_RATES
    out["audio_effects"] = True
    return web.json_response(out)


def canvas_model_choice(provider, cap, model):
    if cap != "video":
        return {"id":model}
    kind = provider["kind"]
    audio = motion_reference.supports_audio(provider,model)
    video = motion_reference.supports(provider,model)
    ref_images = motion_reference.image_reference_limit(provider,model)
    model_for_limits = motion_reference.video_model_for_limits(provider,model)
    count, seconds = motion_reference.av_limits(model_for_limits)
    return {"id":model,"draft":remote.supports_video_draft(provider,model),
            "durations":[5,8,10,14] if kind == "local_h3" else remote.video_durations(kind,model,provider=provider),
            "qualities":remote.video_resolutions(kind,model,provider=provider),
            **({"endpoint_model":model_for_limits} if model_for_limits != model else {}),
            "accepts_audio":audio,"accepts_video":video,
            **({"reference_limits":{"images":ref_images,"videos":count if video else 0,
                "audio":count if audio else 0,"seconds":seconds,**({"total":12} if kind == "minimax" else {})}} if ref_images else {})}


def canvas_reference_choices(**constraints):
    services = {}
    for route in reference_routes(**constraints, all_models=True):
        provider, model = route["provider"], route["model"]
        option = canvas_model_choice(provider, "video", model)
        service = services.setdefault(provider["id"], {"id":provider["id"], "name":provider["name"],
                                                       "model":model, "draft":option["draft"], "models":[]})
        service["models"].append(option)
    return list(services.values())


@console_routes.get("/api/admin/providers")
async def admin_providers(_):
    return web.json_response({"providers": [providers.public(x) for x in providers.all_providers()],
                              "catalog": providers.CATALOG, "caps": providers.CAPS,
                              "routes": {c: [{"provider_id": r["provider"]["id"], "model": r["model"]} for r in providers.routes(c)] for c in providers.CAPS}})


@console_routes.post("/api/admin/providers")
async def admin_provider_save(req):
    p = await req.json()
    try:
        pid = providers.save(p.get("id"), p.get("kind"), p.get("name"), p.get("config") or {}, p.get("secrets") or {}, p.get("enabled", True))
    except providers.ProviderError as e:
        raise bad(str(e))
    return web.json_response({"id": pid})


@console_routes.delete("/api/admin/providers/{pid}")
async def admin_provider_del(req):
    try:
        providers.delete(req.match_info["pid"])
    except providers.ProviderError as e:
        raise bad(str(e))
    return web.json_response({"ok": True})


@console_routes.post("/api/admin/providers/{pid}/test")
async def admin_provider_test(req):
    p = providers.get(req.match_info["pid"])
    if not p:
        raise bad("没有这个服务")
    t0 = time.time()
    try:
        r = await providers.test(req.app["http"], p)
    except Exception as e:
        raise bad(str(e) or e.__class__.__name__)
    r["seconds"] = round(time.time() - t0, 1)
    return web.json_response(r)


def llm_choices() -> dict:
    lst = [{"id": p["id"], "name": p["name"], "kind": p["kind"], "local": p["kind"].startswith("local_"),
            "model": providers.default_model(p, "text"), "vision": "vision" in providers.caps_of(p)}
           for p in providers.all_providers() if p["enabled"] and "text" in providers.caps_of(p)]
    cur = providers.primary("text")
    return {"choices": lst, "current": cur["provider"]["id"] if cur else None}


@console_routes.get("/api/llm")
async def llm_get(_):
    return web.json_response(llm_choices())


@console_routes.put("/api/admin/llm")
async def llm_put(req):
    """The chosen provider goes first for text (and for vision when it can see); the others stay behind it as fallbacks."""
    pid = clean((await req.json()).get("provider"))
    p = providers.get(pid)
    if not p or not p["enabled"] or "text" not in providers.caps_of(p):
        raise bad("这个模型不可用")
    for cap in ("text", "vision"):
        if cap not in providers.caps_of(p):
            continue
        rest = [{"provider_id": r["provider"]["id"], "model": r["model"]} for r in providers.routes(cap) if r["provider"]["id"] != pid]
        for q in providers.all_providers():          # every usable one becomes a fallback, local Qwen last resort included
            if q["enabled"] and cap in providers.caps_of(q) and q["id"] != pid and not any(x["provider_id"] == q["id"] for x in rest):
                rest.append({"provider_id": q["id"], "model": None})
        providers.set_route(cap, [{"provider_id": pid, "model": None}] + rest)
    if pid != "local_qwen" and req.app["llm"].running():
        req.app["llm"].stop()                        # local Qwen not needed now; free its memory
    return web.json_response(llm_choices())


@console_routes.put("/api/admin/routes/{cap}")
async def admin_route(req):
    items = (await req.json()).get("items") or []
    try:
        providers.set_route(req.match_info["cap"], items)
    except providers.ProviderError as e:
        raise bad(str(e))
    return web.json_response({"ok": True})


@console_routes.get("/api/tasks")
async def task_list(req):
    """Task center: mine, or everyone's for admins (?all=1); with totals for the period."""
    u = req["user"]
    days = max(1, min(90, int(req.query.get("days") or 7)))
    since = time.time() - days * 86400
    every = u["role"] == "admin" and req.query.get("all") == "1"
    where, args = "created>?", [since]
    if not every:
        where += " AND user_id=?"; args.append(u["id"])
    if req.query.get("state"):
        where += " AND state=?"; args.append(req.query["state"])
    rows = db.q(f"SELECT id,user_id,board_id,label,capability,provider_id,provider_kind,model,state,created,started,finished,seconds,cost,error,outputs "
                f"FROM tasks WHERE {where} ORDER BY created DESC LIMIT 300", *args)
    names = {x["id"]: x["name"] or x["username"] for x in db.q("SELECT id,name,username FROM users")}
    pnames = {x["id"]: x["name"] for x in db.q("SELECT id,name FROM providers")}
    for r in rows:
        r["user"] = names.get(r["user_id"]); r["provider"] = pnames.get(r["provider_id"], r["provider_id"])
        try:
            r["outputs"] = json.loads(r["outputs"] or "[]")
        except ValueError:
            r["outputs"] = []
        live = JOBS.get(r["id"])
        if live and r["state"] in ("queued", "running"):
            r["state"] = live["state"]; r["eta"] = round(remaining(live))
    tot = db.q(f"SELECT provider_id, capability, COUNT(*) n, SUM(state='done') ok, SUM(state='error') bad, SUM(COALESCE(seconds,0)) secs, SUM(COALESCE(cost,0)) cost "
               f"FROM tasks WHERE {where} GROUP BY provider_id, capability", *args)
    for t in tot:
        t["provider"] = pnames.get(t["provider_id"], t["provider_id"])
    return web.json_response({"tasks": rows, "totals": tot, "days": days})


def text_name():
    r = providers.primary("text")
    return None if not r or r["provider"]["kind"] == "local_qwen" else f'{r["provider"]["name"]}（{r["model"]}）'


@routes.get("/api/status")
async def status(req):
    try:   # our engine first; the old ComfyUI only if it still runs
        async with req.app["http"].get(ENGINE + "/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
            s = await r.json()
        llm = req.app["llm"]
        return web.json_response({"comfy": bool(s.get("ready")), "engine": True, "loading": s.get("loading"),
                                  "running": 1 if s.get("running") else 0, "pending": s.get("queue", 0),
                                  "llm": llm.available(), "llm_running": llm.running(), "llm_device": llm.device if llm.running() else None,
                                  "remote": text_name()})
    except Exception:
        pass
    try:
        async with req.app["http"].get(f"{COMFY}/queue", timeout=aiohttp.ClientTimeout(total=3)) as r:
            q = await r.json()
        llm = req.app["llm"]
        return web.json_response({"comfy": True, "running": len(q.get("queue_running", [])), "pending": len(q.get("queue_pending", [])),
                                  "llm": llm.available(), "llm_running": llm.running(), "llm_device": llm.device if llm.running() else None,
                                  "remote": text_name()})
    except Exception:
        return web.json_response({"comfy": False})


def on_first_admin(uid: int):
    """Everything made before accounts existed belongs to the first administrator; library items stay shared."""
    for f in BOARDS.glob("*.json"):
        b = board_meta(f)
        if b and not b.get("owner"):
            b["owner"] = uid
            write_board(f, b)
    items = lib_load()
    for a in items:
        a.setdefault("owner", uid); a.setdefault("shared", True)
    if items:
        LIBRARY.write_text(json.dumps(items, ensure_ascii=False, indent=1))


async def on_start(app):
    db.conn()
    providers.seed()
    providers.migrate_settings(DATA / "settings.json")
    app["on_first_admin"] = on_first_admin
    app["http"] = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120))
    app["ws_task"] = asyncio.create_task(comfy_ws(app))
    app["llm"] = rewriter.LLM(COMFY, lambda: app["http"])
    app["llm_task"] = asyncio.create_task(app["llm"].reaper())
    app["tts_task"] = asyncio.create_task(tts.reaper())
    app["remote_tasks"] = set()
    recover_remote_videos(app)


def recover_remote_videos(app):
    rows = db.q("""SELECT * FROM tasks WHERE capability='video' AND state IN ('queued','running')
                  AND CASE WHEN json_valid(request) THEN json_type(request,'$.remote_video')='object' ELSE 0 END
                  ORDER BY created""")
    for row in rows:
        restore_logged_job(app, row)


async def on_stop(app):
    app["ws_task"].cancel()
    app["llm_task"].cancel()
    app["llm"].stop()
    app["tts_task"].cancel()
    tts.stop()
    tasks = tuple(app["remote_tasks"])
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await app["http"].close()


def main():
    app = web.Application(client_max_size=64 * 1024 * 1024, middlewares=[auth.middleware, media_input_guard])
    agent_chat.install(app, sys.modules[__name__])
    canvas_live.install(app, sys.modules[__name__])
    app.add_routes(routes)
    app.add_routes(auth.routes)
    app.add_routes(console_routes)
    app.add_routes(local_admin.routes)
    creative_events.install(app,ROOT,COMFY_DIR)
    mcp_bridge.install(app,ROOT)
    shared_canvas_items.install(app,sys.modules[__name__])
    connector_oauth.install(app)
    app.router.add_static("/static", ROOT / "static")
    app.on_startup.insert(0, on_start)
    app.on_cleanup.append(on_stop)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log_class=motion_reference.PublicAccessLogger,
                print=lambda *_: print(f"OneShot: http://0.0.0.0:{PORT}", flush=True))


if __name__ == "__main__":
    main()
