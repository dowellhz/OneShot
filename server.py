#!/usr/bin/env python3
"""OneShot: AI video studio — canvas, 一句话成片 wizard, 剪辑台, console; local H3 engine and third-party models.

Builds ComfyUI API graphs for H3 text-to-image, text/first/last-frame-to-video (FL2VA) and keyframe/reference video
(Ref2VA), tracks the jobs over ComfyUI's websocket, and keeps the board in data/board.json.
"""
import asyncio, io, json, math, os, random, re, time, uuid, hashlib, zipfile
from pathlib import Path

import aiohttp
from urllib.parse import quote

import rewriter
import fields as pfields
import tools
import render as film
import tts
import db
import auth
import providers
import remote
import local_admin
import image_editor
import agent_chat
import creative_memory
import board_store
import video_remake
from board_store import BOARD_ID as _ID, board_meta, can_see
import sys
from aiohttp import web

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
PORT = int(os.environ.get("H3STUDIO_PORT", "8190"))
ROOT = Path(__file__).resolve().parent
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


def planned_prompt(prompt: str, subj, frames, end: float) -> str:
    """Ref2VA's structured prompt for character references (<Picture 1..S>) and timed frames (<Picture S+1..>)."""
    S = len(subj)
    lines, keep, steps = [], [], ""
    for k, im in enumerate(subj):
        cap = clean(im.get("caption"))
        subject = {"scene": "environment", "prop": "object", "style": "visual style"}.get(im.get("memory_kind"), "character")
        lines.append(f"<Subject {k+1}> is the {subject} in <Picture {k+1}>" + (f", {cap}." if cap else "."))
        features = "visual style, colors and lighting" if subject == "visual style" else "layout, materials, colors and visual details" if subject != "character" else "face, body shape, colors and outfit"
        keep.append(f"<Subject {k+1}>: fully_preserved - the {features} of <Subject {k+1}> stay identical to <Picture {k+1}> throughout.")
    for j, im in enumerate(frames):
        pn, t, cap = S + j + 1, float(im["time"]), clean(im.get("caption")) or "the scene"
        kind = "first frame" if t <= 0.01 else ("last frame" if t >= end - 0.05 else "keyframe")
        lines.append(f"<Picture {pn}> is the {kind} of [Shot 1], showing {cap}.")
        keep.append(f"<Picture {pn}> ([Shot 1] {kind}): fully_preserved - " + ("the video starts exactly from it." if kind == "first frame" else f"reached at {ts(t)}."))
        if kind != "first frame":
            steps += f" At {ts(t)} the shot matches <Picture {pn}>."
    tag = "[keyframe completion + reference generation]" if frames else "[reference generation]"
    start = " The shot begins from <Picture %d>." % (S + 1) if frames and float(frames[0]["time"]) <= 0.01 else ""
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
        prompt = re.sub(r"@图(\d+)", lambda m: "首帧画面" if m.group(1) == "1" else ("尾帧画面" if int(m.group(1)) == n else f"图{m.group(1)}"), prompt)
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
        j["meta"]["mode_name"] = {"region": "局部重绘", "whole": "整图编辑", "outpaint": "智能扩图"}[spec["mode"]]
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
        try:
            spec = j.get("meta", {}).get("image_edit")
            if spec:
                j["phase"] = "compositing"
                if spec.get("recipe") is not None:
                    spec["recipe"]["seed"] = j["meta"].get("seed", spec["recipe"].get("seed", -1))
                outputs = await asyncio.to_thread(image_editor.composite, COMFY_DIR, spec, outputs)
            if j.get("cancel"):
                return
            j.update(outputs=outputs, state="done", phase="done", finished=time.time())
            record(j)
        except Exception as e:
            if not j.get("cancel"):
                j.update(state="error", error=f"图像编辑合成失败：{e}")
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
                       error=j.get("error"), outputs=[o.get("ref") for o in j.get("outputs") or []])
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
    return board_store.clean_board(v, COMFY_DIR)


def write_board(path: Path, data: dict):
    creative_memory.remove_deleted_bindings(data)
    board_store.write_board(path, data)


@routes.get("/api/boards")
async def list_boards(req):
    u = req["user"]
    BOARDS.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(BOARDS.glob("*.json"), key=lambda f: -f.stat().st_mtime):
        b = board_meta(f)
        if not b or not can_see(u, b):
            continue
        if u["role"] == "admin" and req.query.get("all") != "1" and b.get("owner") not in (None, u["id"]) and not b.get("shared"):
            continue                       # admins see others' private boards only on request (console)
        v = next((n["versions"][n["cur"]] for n in reversed(b.get("nodes", [])) if n.get("type") == "video" and n.get("versions") and n.get("cur", -1) >= 0), None)
        out.append({"id": f.stem, "name": b.get("name") or "未命名画布", "nodes": len(b.get("nodes", [])), "mtime": f.stat().st_mtime,
                    "owner": b.get("owner"), "shared": bool(b.get("shared")), "wiz": (b.get("wiz") or {}).get("step"),
                    "cover": (v or {}).get("cover_url") or (v or {}).get("url")})
    return web.json_response(out)


@routes.get("/api/boards_legacy")
async def list_boards_legacy(_):
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
        out.append({"id": f.stem, "name": b.get("name") or "未命名画布", "nodes": len(b.get("nodes", [])), "mtime": f.stat().st_mtime})
    return web.json_response(out)


@routes.get("/api/board/{bid}")
async def get_board(req):
    f = board_path(req.match_info["bid"])
    b = board_meta(f)
    if b and not can_see(req["user"], b):
        raise bad("没有权限打开这个项目")
    creative_memory.remove_deleted_bindings(b)
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
    if old and not (u["role"] == "admin" or old.get("owner") in (None, u["id"]) or old.get("shared")):
        raise bad("没有权限修改这个项目")
    data["owner"] = old.get("owner") or u["id"]          # the owner never changes through a save
    data["shared"] = bool(data.get("shared")) if (data["owner"] == u["id"] or u["role"] == "admin") else bool(old.get("shared"))
    # optimistic concurrency: a page may only overwrite the revision it loaded (another tab, an unload save of a stale
    # page, or a server-side edit would otherwise be silently lost)
    cur = old.get("rev")
    if cur is not None and data.get("rev") != cur:
        return web.json_response({"error": "画布已在别处更新", "stale": True, "rev": cur}, status=409)
    data["rev"] = int(cur or 0) + 1
    write_board(f, data)
    return web.json_response({"ok": True, "rev": data["rev"]})


@routes.delete("/api/board/{bid}")
async def delete_board(req):
    f = board_path(req.match_info["bid"])
    old = board_meta(f) if f.exists() else {}
    if old and not (req["user"]["role"] == "admin" or old.get("owner") in (None, req["user"]["id"])):
        raise bad("只有项目的主人可以删除")
    if f.exists():
        f.rename(f.with_suffix(".deleted"))
    return web.json_response({"ok": True})


def refs_of_user(u: dict) -> set:
    seen = set()
    for f in BOARDS.glob("*.json"):
        b = board_meta(f)
        if b and (b.get("owner") in (None, u["id"]) or b.get("shared")):
            for n in b.get("nodes", []):
                for v in n.get("versions", []):
                    seen.add(v.get("ref"))
    return seen


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
                "frame" if f.name.startswith(("last_", "shot_")) else "tile" if f.name.startswith("tile") else "upload")
            out.append({"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "type": "video" if ext in tools.VIDEO_EXT else "image",
                        "source": src,
                        "mtime": f.stat().st_mtime})
    out.sort(key=lambda a: -a["mtime"])
    return web.json_response(out[:300])


@routes.post("/api/upload")
async def upload(req):
    reader = await req.multipart()
    part = await reader.next()
    raw = await part.read(decode=False)
    ext = os.path.splitext(part.filename or "x.png")[1].lower() or ".png"
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


@routes.get("/media")
async def media(req):
    try:
        f = tools.ref_path(COMFY_DIR, req.query.get("ref", ""))
    except ValueError:
        raise web.HTTPBadRequest()
    if f.suffix.lower() not in MEDIA_EXT or not f.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(f, headers={"Cache-Control": "max-age=86400", "X-Content-Type-Options": "nosniff"})


CANVAS_MEDIA_EXT = creative_memory.IMAGE_EXT | tools.VIDEO_EXT
MEDIA_EXT = CANVAS_MEDIA_EXT | {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}


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
            nm = (im.get("name") or "").strip()
            if nm and not re.fullmatch(r"(图片|image)\s*\d+.*", nm, re.I) and not any(n in nm for n in ppl):
                ppl[nm] = clean(im.get("caption")) or "the character in the reference image"
        for k, im in enumerate(refs):
            label = f"{im.get('name') or ''} {im.get('caption') or ''}"
            hit = next((n for n in ppl if n and n in label), None)
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
_MARKS = re.compile(r"<(?:Picture|Subject|Video|Audio) \d+>|\(S\d+(?:,S\d+)*\)|<d>.*?</d>", re.S)
XLATE_FILE = DATA / "xlate_cache.json"
try:
    _XLATE_CACHE: dict = json.loads(XLATE_FILE.read_text())
except Exception:
    _XLATE_CACHE = {}
XLATE_SYSTEM = """You translate the parts of a video-generation prompt from Chinese into natural, concrete English.
Input: a JSON object. Output: ONLY a JSON object with exactly the same keys and the same list lengths, every value translated.
Rules:
- Translate faithfully; do not add, drop or reorder actions, objects, counts, positions or constraints.
- Copy these verbatim, unchanged: every <d>...</d> block including its content and [Language] tag, every <Picture N>, <Subject N>, <Video N>, <Audio N>, and every speaker ID such as (S1).
- Text that appears in double quotation marks as visible on-screen text stays as it is.
- Write descriptions, not speech. Use plain prose; no markdown, no explanations."""


def _needs_english(t: str) -> bool:
    return bool(t) and bool(_CJK.search(_DBLOCK.sub("", t)))


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
    """The exact prompt the model would get for this request (no generation)."""
    p = apply_fields(await req.json())
    if not clean(p.get("prompt")):
        raise web.HTTPBadRequest(text=json.dumps({"error": "提示词为空"}, ensure_ascii=False), content_type="application/json")
    p = await to_english(req.app, p)
    _, meta = graph_video(p)
    mode = meta.get("mode_name", "") + (" · 未翻译成英文：" + p["_xlate_err"] if p.get("_xlate_err") else "")
    return web.json_response({"prompt": meta.get("full_prompt", p["prompt"]), "mode": mode})


@routes.post("/api/generate")
async def generate(req):
    raw = await req.json()
    # Only the validated editor endpoint may provide a compositing specification.
    raw.pop("_image_edit", None)
    raw.pop("_native_inpaint", None)
    raw.pop("_preserve_speech_motion", None)
    return await generate_request(req, raw)


@routes.post("/api/image-edit/transform")
async def image_transform(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise bad("图像编辑参数须为对象")
    try:
        r = await asyncio.to_thread(image_editor.transform, COMFY_DIR, p)
    except (ValueError, OSError, TypeError) as e:
        raise bad(str(e))
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
    return web.json_response(result)


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
    try:
        async with req.app["http"].get(ENGINE + "/status", timeout=aiohttp.ClientTimeout(total=4)) as r:
            s = await r.json()
        return web.json_response(s.get("editor", {}))
    except Exception:
        return web.json_response({"segment": False, "cutout": False, "native": False})


@routes.post("/api/image-edit/segment")
@routes.post("/api/image-edit/cutout")
async def image_edit_tool(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise bad("图像编辑参数须为对象")
    tool = req.path.rsplit("/", 1)[-1]
    return web.json_response(await run_image_tool(req.app, tool, p))


async def run_image_tool(app, tool, p):
    try:
        image = tools.ref_path(COMFY_DIR, p.get("ref", ""))
        await asyncio.to_thread(image_editor.load, COMFY_DIR, p.get("ref", ""))
        out, ref = tools._new(COMFY_DIR, "output", "selection" if tool == "segment" else "cutout", ".png")
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


@routes.post("/api/assets/export")
async def export_assets(req):
    p = await req.json()
    refs = p.get("refs") if isinstance(p, dict) else None
    if not isinstance(refs, list) or not 1 <= len(refs) <= 100 or not all(isinstance(ref, str) for ref in refs):
        raise bad("请选择 1–100 个素材")
    allowed = None if req["user"]["role"] == "admin" else refs_of_user(req["user"])
    paths = []
    for ref in dict.fromkeys(refs):
        try:
            path = tools.ref_path(COMFY_DIR, ref)
        except ValueError:
            raise bad("素材引用不正确")
        if (allowed is not None and ref not in allowed) or not path.is_file() or path.suffix.lower() not in MEDIA_EXT:
            raise bad("素材不存在或没有访问权限")
        paths.append(path)
    directory = DATA / "exports"; directory.mkdir(parents=True, exist_ok=True)
    dst = directory / (uuid.uuid4().hex + ".zip")
    def archive():
        with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
            for i, path in enumerate(paths):
                z.write(path, f"{i + 1:02d}_{path.name}")
        # Exports contain only references already authorized above. Remove old archives.
        for old in directory.glob("*.zip"):
            if old != dst and time.time() - old.stat().st_mtime > 86400:
                old.unlink(missing_ok=True)
    await asyncio.to_thread(archive)
    return web.FileResponse(dst, headers={"Content-Disposition": 'attachment; filename="OneShot-assets.zip"'})


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
            raw["_native_inpaint"]["prompt"] += prepared["prompt"][len(raw["prompt"]):]
        response = await generate_native_image(req, raw)
        result = json.loads(response.body)
        memory.track(req["user"], prepared, result)
        result["memory_used"] = prepared.get("memory_used", [])
        return web.json_response(result)
    return await generate_request(req, raw)


async def generate_request(req, raw):
    memory = req.app["creative_memory"]
    draft = raw.get("character_draft")
    if draft is not None:
        draft = memory.character_draft_request(req["user"], raw, draft)
    payload = memory.prepare(req["user"], raw)
    response = await _generate_request(req, payload)
    result = json.loads(response.body)
    memory.track(req["user"], payload, result, draft)
    memory.observe(req["user"], {jid: JOBS[jid] for jid in result.get("ids", []) if jid in JOBS})
    if payload.get("memory_used"):
        result["memory_used"] = payload["memory_used"]
        result["memory_context"] = {k: payload[k] for k in ("prompt", "images", "planned") if k in payload}
    return web.json_response(result)


async def _generate_request(req, raw):
    u = req["user"]
    cap = "image" if raw.get("kind") == "image" else "video"
    choice = providers.get(raw["provider"]) if raw.get("provider") else None
    if choice and not (choice["enabled"] and cap in providers.caps_of(choice)):
        choice = None
    route = {"provider": choice, "model": raw.get("provider_model") or providers.default_model(choice, cap)} if choice else providers.primary(cap)
    if route and route["provider"]["kind"] != "local_h3":
        return await generate_remote(req, raw, route, cap)
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
    comfy_ids = [i for i in ids if not (JOBS.get(i, {}).get("out_ref") or i[:1] in "xrtp" and len(i) == 13)]
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
    import av
    ref = (await req.json())["ref"]
    try:
        src = tools.ref_path(COMFY_DIR, ref)
    except ValueError:
        raise web.HTTPBadRequest()
    path = ref.split(":", 1)[1]

    def grab():
        last = None
        with av.open(str(src)) as c:
            for f in c.decode(video=0):
                last = f
        img = last.to_image()
        name = f"last_{Path(path).stem}_{uuid.uuid4().hex[:4]}.png"
        dst = COMFY_DIR / "input" / "h3studio" / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        img.save(dst)
        return f"input:h3studio/{name}", img.size

    new_ref, size = await asyncio.get_running_loop().run_in_executor(None, grab)
    return web.json_response({"ref": new_ref, "url": "/media?ref=" + quote(new_ref, safe=""), "w": size[0], "h": size[1]})


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
    return await llm_call(req, tools.storyboard(req.app["llm"], COMFY_DIR, p["story"], p.get("refs") or [], p.get("shots"),
                                                p.get("seconds"), clean(p.get("style")), p.get("aspect") or "16:9"))


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
    return await llm_call(req, tools.analyze_shots(req.app["llm"], COMFY_DIR, cut))


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
    return web.json_response({"tiles": tiles})


@routes.post("/api/concat")
async def concat(req):
    p = await req.json()
    try:
        r = await asyncio.get_running_loop().run_in_executor(None, tools.concat, COMFY_DIR, p.get("refs") or [])
    except Exception as e:
        raise bad(f"拼接失败：{e}")
    r["url"] = "/media?ref=" + quote(r["ref"], safe="")
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
    if isinstance(data, dict) and data.pop("recreate_deleted", False):
        mid = data.get("id")
        if isinstance(mid, str) and db.one("SELECT 1 FROM creative_memories WHERE id=? AND deleted=1", mid):
            data.pop("id")
            data.setdefault("board", data.get("source_board", ""))
    return web.json_response(req.app["creative_memory"].put(req["user"], data))


@routes.delete("/api/library/{aid}")
async def library_del(req):
    req.app["creative_memory"].delete(req["user"], req.match_info["aid"])
    return web.json_response({"ok": True})


RENDER_LOCK = asyncio.Lock()


@routes.post("/api/render")
async def render_film(req):
    """成片: render a timeline in the background; it is tracked like a generation job (poll /api/jobs)."""
    p = await req.json()
    return enqueue_film(req, p.get("spec") or {}, label=p.get("label"))


def enqueue_film(req, spec, *, label=None, source_audio=None, board=None, display=True):
    clips = [c for c in spec.get("clips") or [] if c.get("ref")]
    if not clips:
        raise bad("时间线上没有视频")
    secs = sum(max(0.5, float(c.get("out") or 8) - float(c.get("in") or 0)) for c in clips)
    def render_timeline(progress, cancelled):
        return film.render(COMFY_DIR, spec, progress, cancelled, source_audio=source_audio, display=display)
    return enqueue_render(req, render_timeline, seconds=secs, label=label, board=board)


def enqueue_render(req, render_clip, *, seconds, label=None, board=None):
    jid = "r" + uuid.uuid4().hex[:12]
    j = JOBS[jid] = {"id": jid, "kind": "render", "state": "queued", "created": time.time(),
                     "meta": {"label": clean(label)[:60] or "成片", "est": round(3 + seconds * FPS_EST, 1), "cls": "render", "units": seconds,
                              "uid": req["user"]["id"], "board": board, "mode_name": "成片"}}
    db.task_start(id=jid, user_id=req["user"]["id"], board_id=board, capability="render",
                  label=j["meta"]["label"])

    async def run():
        async with RENDER_LOCK:
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
                    j.update(state="error", error=f"合成失败：{e}"[:500])
                log_end(j)
                return
            if j.get("cancel"):
                return
            extra = {"cover": r.get("cover"), "cover_url": "/media?ref=" + quote(r["cover"], safe="") if r.get("cover") else None}
            j["outputs"] = [{"ref": r["ref"], "url": "/media?ref=" + quote(r["ref"], safe=""),
                             "meta": {"width": r["w"], "height": r["h"], "duration": r["seconds"]}, "extra": extra}]
            j["finished"] = time.time(); j["state"] = "done"
            log_end(j)
            record(j)
    asyncio.create_task(run())
    return web.json_response({"ids": [jid], "meta": j["meta"]})


FPS_EST = 0.45   # render seconds per second of film (768p, measured); refined by the stats


@routes.post("/api/cover")
async def cover(req):
    p = await req.json()
    try:
        r = await asyncio.get_running_loop().run_in_executor(None, film.cover_frame, COMFY_DIR, p["ref"], float(p.get("at") or 0))
    except Exception as e:
        raise bad(f"取封面失败：{e}")
    r["url"] = "/media?ref=" + quote(r["ref"], safe="")
    return web.json_response(r)


@routes.post("/api/upload_audio")
async def upload_audio(req):
    reader = await req.multipart()
    part = await reader.next()
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
    return web.json_response(r)


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
    foreign = sum(1 for i in order if i not in JOBS)
    return web.json_response({"jobs": out, "total": round(max(t, rt)), "foreign": foreign})


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
            db.task_update(pid, request=json.dumps({"engine": {"id": j["eid"], "out_ref": j["out_ref"]}}))
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
    imgs = p.get("images") or []
    paths = [str(tools.ref_path(COMFY_DIR, im["ref"])) for im in imgs]
    body = {"kind": "video", "prompt": meta["full_prompt"], "frames": min(345, max(124, meta["frames"])), "height": meta["height"],
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


_following = False


def job_from_log(row):
    kind = "image" if row.get("capability") == "image" else "video"
    return {"id":row["id"], "kind":kind, "state":row["state"], "created":row.get("created") or time.time(),
            "meta":{"label":row.get("label"), "uid":row.get("user_id"), "board":row.get("board_id"),
                    "mode_name":(row.get("model") or "").replace("MiniMax-H3 ", "")}}


def restore_logged_job(app, row):
    jid = row["id"]
    job = job_from_log(row)
    if row["state"] in ("done", "error"):
        try:
            refs = json.loads(row.get("outputs") or "[]")
        except (ValueError, TypeError):
            refs = []
        outputs = []
        for ref in refs if isinstance(refs, list) else []:
            if not isinstance(ref, str):
                continue
            try:
                path = tools.ref_path(COMFY_DIR, ref)
            except ValueError:
                continue
            outputs.append({"ref":ref, "url":"/media?ref=" + quote(ref, safe=""),
                            "meta":media_info(path, job["kind"])})
        job.update(error=row.get("error"), outputs=outputs, _logged=True)
        JOBS[jid] = job
        return job
    try:
        receipt = json.loads(row.get("request") or "{}").get("engine") or {}
    except (AttributeError, TypeError, ValueError):
        receipt = {}
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
    if len(jid) != 13 or jid[0] not in "epxrt":
        return None
    job.update(state="error", error="OneShot 已重启，此任务无法恢复，请重试")
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


def media_info(path: Path, kind: str) -> dict:
    try:
        if kind == "video":
            w, h, dur, _ = film.probe(path)
            return {"width": w, "height": h, "duration": round(dur, 2)}
        if kind == "image":
            from PIL import Image
            with Image.open(path) as im:
                return {"width": im.width, "height": im.height}
    except Exception:
        pass
    return {}


async def generate_remote(req, raw: dict, route: dict, cap: str):
    """Run one image / video request on a third-party provider; tracked in JOBS like a local job (id "x…")."""
    p, model = route["provider"], route["model"]
    u = req["user"]
    prompt = plain_prompt(raw)
    if not prompt:
        raise bad("提示词不能为空")
    imgs = []
    for im in raw.get("images") or []:
        try:
            imgs.append({**im, "path": tools.ref_path(COMFY_DIR, im["ref"])})
        except Exception:
            pass
    if cap == "image":
        nreq = {"prompt": re.sub(r"@图(\d+)", r"图\1", prompt), "images": [x["path"] for x in imgs], "ar": float(raw.get("ar") or 1), "n": int(raw.get("count") or 1)}
    else:
        frames = [x for x in imgs if x.get("role") != "subject"]
        nreq = {"prompt": prompt, "first": frames[0]["path"] if frames else None, "last": frames[-1]["path"] if len(frames) > 1 else None,
                "refs": [x["path"] for x in imgs if x.get("role") == "subject"], "duration": float(raw.get("duration") or 5),
                "ar": float(raw.get("ar") or 16 / 9), "quality": raw.get("quality") or "hd", "audio": True}
    cls = f"remote|{p['kind']}|{cap}|{model}"
    count = 1 if cap == "image" else max(1, min(3, int(raw.get("count") or 1)))
    ids = []
    for _ in range(count):
        jid = "x" + uuid.uuid4().hex[:12]
        meta = {"label": clean(raw.get("label"))[:60] or p["name"], "cls": cls, "units": 1, "est": estimate(cls, 1, 40 if cap == "image" else 150),
                "mode_name": f"{p['name']} · {model}", "uid": u["id"], "provider": p["name"], "prompt": prompt}
        j = JOBS[jid] = {"id": jid, "kind": cap, "state": "queued", "created": time.time(), "meta": meta}
        attach_image_edit(j, raw)
        db.task_start(id=jid, user_id=u["id"], board_id=clean(raw.get("board")), label=meta["label"], capability=cap, provider_id=p["id"],
                      provider_kind=p["kind"], model=model, state="queued", request={"prompt": prompt[:2000]})
        asyncio.create_task(run_remote(req.app, j, p, model, cap, nreq))
        ids.append(jid)
    return web.json_response({"ids": ids, "meta": JOBS[ids[0]]["meta"]})


REMOTE_SEM: dict = {}


async def run_remote(app, j: dict, p: dict, model: str, cap: str, nreq: dict):
    sem = REMOTE_SEM.setdefault(p["id"], asyncio.Semaphore(3))       # be polite to each provider
    async with sem:
        if j.get("cancel"):
            return
        j["state"] = "running"; j["started"] = time.time()
        try:
            r = await remote.run(app["http"], COMFY_DIR, p, model, cap, nreq)
            outs = []
            for f in r["files"]:
                outs.append({"ref": f["ref"], "url": "/media?ref=" + quote(f["ref"], safe=""), "meta": media_info(f["path"], f["kind"])})
            if j.get("cancel"):
                return
            await complete_outputs(j, outs)
            db.task_update(j["id"], cost=r.get("cost"), units=r.get("units"))
        except Exception as e:
            if j["state"] != "error":
                j["state"] = "error"; j["error"] = str(e)[:500] or e.__class__.__name__
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


@console_routes.get("/api/capabilities")
async def capabilities(req):
    """What each node can pick: providers that offer a capability (default first)."""
    out = {}
    for cap in providers.CAPS:
        rts = providers.routes(cap)
        default = rts[0]["provider"]["id"] if rts else None
        lst = []
        for pr in providers.all_providers():
            if pr["enabled"] and cap in providers.caps_of(pr):
                lst.append({"id": pr["id"], "name": pr["name"], "kind": pr["kind"], "local": pr["kind"].startswith("local_"),
                            "model": providers.default_model(pr, cap), "default": pr["id"] == default})
        lst.sort(key=lambda x: (not x["default"], not x["local"]))
        out[cap] = lst
    return web.json_response(out)


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


async def on_stop(app):
    app["ws_task"].cancel()
    app["llm_task"].cancel()
    app["llm"].stop()
    app["tts_task"].cancel()
    tts.stop()
    await app["http"].close()


def main():
    app = web.Application(client_max_size=64 * 1024 * 1024, middlewares=[auth.middleware])
    agent_chat.install(app, sys.modules[__name__])
    app.add_routes(routes)
    app.add_routes(auth.routes)
    app.add_routes(console_routes)
    app.add_routes(local_admin.routes)
    app.router.add_static("/static", ROOT / "static")
    app.on_startup.insert(0, on_start)
    app.on_cleanup.append(on_stop)
    web.run_app(app, host="0.0.0.0", port=PORT, print=lambda *_: print(f"OneShot: http://0.0.0.0:{PORT}", flush=True))


if __name__ == "__main__":
    main()
