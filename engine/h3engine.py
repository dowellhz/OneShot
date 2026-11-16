"""H3 engine without ComfyUI: the full MiniMax-H3 (31B BF16) on one RTX 4090, through diffusers' MiniMax-H3 modular pipeline.

Weights: the single-file checkpoints already on disk (Comfy-Org layout) are converted at load time:
  * transformer (fl2va / ref2va): diffusers' own single-file converter, after fusing the turbo LoRA in the original layout;
  * text encoder: Qwen3-VL with the keys renamed (`model.layers` → `model.language_model.layers`, `visual` → `model.visual`);
    the file holds the 50 decoder layers H3 reads (it conditions on hidden_states[50]); a 51st layer is added so that
    hidden_states[50] stays the pre-norm output, and its weights are never used for the conditioning;
  * VAEs, scheduler, tokenizer, processor: the official diffusers folders (MiniMax/MiniMax-H3).

Memory (24 GB VRAM, 125 GB RAM), the same idea as ComfyUI's low-VRAM mode: weights live in one pinned host buffer
and stream to the GPU one transformer block / one text-encoder layer ahead of the compute (CUDA streams); the first
`resident` transformer blocks stay on the GPU for good. The text encoder is stored in FP8 on the host and cast to BF16
per layer on the GPU.
"""
from __future__ import annotations

import gc
import itertools
import json
import os
import re
import time
import weakref
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

H3 = Path(os.environ.get("H3_WEIGHTS", "/d2/Lego/minimax-h3"))
IMG_BASE = Path(os.environ.get("H3_IMAGE_BASE", "/d2/Lego/minimax-h3/MiniMax-H3-Image"))
BASE = Path(os.environ.get("H3_BASE", str(Path.home() / "h3engine/MiniMax-H3")))
FILES = {
    "fl2va": H3 / "diffusion_models/minimax_h3_fl2va_bf16.safetensors",
    "ref2va": H3 / "diffusion_models/minimax_h3_ref2va_bf16.safetensors",
    "te": H3 / "text_encoders/qwen3vl_32b_minimax_h3_bf16.safetensors",
}
LORAS = {
    "fl2va_768": H3 / "loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
    "fl2va_8": H3 / "loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
    "ref2va_4": H3 / "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
}
DEV = torch.device("cuda")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------- pinned host memory (one arena per module)

def pin_module(module: nn.Module) -> None:
    """Move a module's CPU tensors into one page-locked buffer (Tensor.pin_memory rounds every tensor up to 2^n)."""
    ts = [t for t in itertools.chain(module.parameters(), module.buffers()) if t.device.type == "cpu" and not t.is_pinned()]
    if not ts:
        return
    sizes = [t.numel() * t.element_size() for t in ts]
    offs = list(itertools.accumulate((-(-s // 256) * 256 for s in sizes[:-1]), initial=0))
    arena = torch.empty(offs[-1] + sizes[-1], dtype=torch.uint8)
    for t, o, s in zip(ts, offs, sizes):
        v = arena[o:o + s].view(t.dtype).view(t.shape)
        v.copy_(t.data)
        t.data = v
    cud = torch.cuda.cudart()
    err = int(cud.cudaHostRegister(arena.data_ptr(), arena.numel(), 0))
    if err:
        raise RuntimeError(f"cudaHostRegister {arena.numel() / 2**30:.1f} GiB failed ({err})")
    module._h3_arena = arena          # released explicitly by release_module()


def mem_available_gb() -> float:
    for ln in open("/proc/meminfo"):
        if ln.startswith("MemAvailable:"):
            return int(ln.split()[1]) / 2**20
    return 0.0


def need_ram(gb: float, what: str):
    have = mem_available_gb()
    if have < gb:
        raise RuntimeError(f"内存不够加载{what}：需要约 {gb:.0f} GB，现在可用 {have:.0f} GB（是不是 DeepSeek 网页或别的程序占着内存？）")


def release_module(module: nn.Module) -> None:
    """Give a big model's host memory back now, whoever still holds a reference to the module object.

    diffusers' group offloading keeps its own references to the host tensors (`ModuleGroup.cpu_param_dict`, the
    group's parameter / buffer lists): clear those and drop the hooks first, then empty every tensor."""
    for m in module.modules():
        reg = getattr(m, "_diffusers_hook", None)
        if reg is None:
            continue
        for h in list(getattr(reg, "hooks", {}).values()):
            g = getattr(h, "group", None)
            if g is not None:
                for attr in ("cpu_param_dict", "parameters", "buffers", "modules", "tensors"):
                    if hasattr(g, attr):
                        setattr(g, attr, {} if attr == "cpu_param_dict" else [])
            for attr in ("next_group", "group"):
                if hasattr(h, attr):
                    setattr(h, attr, None)
        reg.hooks.clear()
        try:
            del m._diffusers_hook
        except Exception:
            pass
    arena = getattr(module, "_h3_arena", None)
    for t in itertools.chain(module.parameters(), module.buffers()):
        t.data = torch.empty(0, dtype=t.dtype)
    if arena is not None:
        torch.cuda.cudart().cudaHostUnregister(arena.data_ptr())
        module._h3_arena = None
        del arena


# --------------------------------------------------------------------------- VAEs: on the GPU only while used

def gpu_while_used(module: nn.Module, methods=("encode", "decode", "forward")) -> None:
    """Keep a module's weights in pinned host memory and put the whole module on the GPU only for the duration of a
    call (ComfyUI does the same with its VAEs while the transformer denoises). Pinned: the move is ~0.3 s for 5 GB, and
    going back costs nothing (the tensors just point at their host copies again)."""
    module.to("cpu")
    pin_module(module)
    host = [(t, t.data) for t in itertools.chain(module.parameters(), module.buffers())]
    depth = [0]

    def wrap(fn):
        def run(*a, **k):
            if depth[0] == 0:
                for t, h in host:
                    t.data = h.to(DEV, non_blocking=True)
            depth[0] += 1
            try:
                return fn(*a, **k)
            finally:
                depth[0] -= 1
                if depth[0] == 0:
                    torch.cuda.current_stream().synchronize()
                    for t, h in host:
                        t.data = h
                    torch.cuda.empty_cache()
        return run
    for name in methods:
        fn = getattr(module, name, None)
        if callable(fn):
            setattr(module, name, wrap(fn))


# --------------------------------------------------------------------------- FP8 storage for the text encoder

class FP8Linear(nn.Module):
    """Weight stored as float8_e4m3fn with a per-output-row scale; computed in BF16."""

    def __init__(self, lin: nn.Linear):
        super().__init__()
        w = lin.weight.data.float()
        scale = (w.abs().amax(dim=1, keepdim=True) / 448.0).clamp(min=1e-12)
        self.weight = nn.Parameter((w / scale).to(torch.float8_e4m3fn), requires_grad=False)
        self.scale = nn.Parameter(scale.to(torch.bfloat16), requires_grad=False)
        self.bias = nn.Parameter(lin.bias.data.to(torch.bfloat16), requires_grad=False) if lin.bias is not None else None
        self.in_features, self.out_features = lin.in_features, lin.out_features

    def forward(self, x):
        w = self.weight.to(x.dtype) * self.scale.to(x.dtype)
        return F.linear(x, w, self.bias)


def fp8_linears(module: nn.Module, skip=("visual",)) -> int:
    n = 0
    for name, child in list(module.named_children()):
        if name in skip:
            continue
        if isinstance(child, nn.Linear) and child.weight.numel() >= 1 << 20:
            setattr(module, name, FP8Linear(child)); n += 1
        else:
            n += fp8_linears(child, ())
    return n


# --------------------------------------------------------------------------- loaders

def read_safetensors(path: Path, dtype=torch.bfloat16) -> dict:
    from safetensors import safe_open
    out = {}
    with safe_open(str(path), "pt") as f:
        for k in f.keys():
            t = f.get_tensor(k)
            out[k] = t.to(dtype) if t.is_floating_point() and t.dtype != dtype and t.dim() > 0 else t
    return out


def fuse_lora(sd: dict, lora_path: Path, strength: float = 1.0) -> int:
    """W += strength * alpha/rank * B @ A, in the checkpoint's own layout (before any conversion)."""
    from safetensors import safe_open
    n = 0
    with safe_open(str(lora_path), "pt") as f:
        keys = set(f.keys())
        bases = sorted({k[: -len(".lora_A.weight")] for k in keys if k.endswith(".lora_A.weight")})
        for b in bases:
            target = b.removeprefix("diffusion_model.") + ".weight"
            if target not in sd:
                continue
            dev = DEV if torch.cuda.is_available() else torch.device("cpu")
            A = f.get_tensor(b + ".lora_A.weight").to(dev, torch.float32)
            B = f.get_tensor(b + ".lora_B.weight").to(dev, torch.float32)
            rank = A.shape[0]
            alpha = float(f.get_tensor(b + ".alpha")) if b + ".alpha" in keys else rank
            w = sd[target]
            wd = w.to(dev, torch.float32)
            wd += (B @ A) * (alpha / rank) * strength
            sd[target] = wd.to(w.dtype).cpu()
            del wd, A, B
            n += 1
    return n


def load_transformer(task: str, lora: str | None):
    from accelerate import init_empty_weights
    from diffusers import MiniMaxH3Transformer3DModel
    from diffusers.loaders.single_file_utils import convert_minimax_h3_transformer_checkpoint_to_diffusers
    t0 = time.time()
    sd = read_safetensors(FILES[task])
    log(f"read {task} transformer: {len(sd)} tensors, {time.time() - t0:.0f}s")
    if lora:
        n = fuse_lora(sd, LORAS[lora])
        log(f"fused LoRA {lora}: {n} matrices")
    sub = "transformer_ref" if task == "ref2va" else "transformer"
    config = MiniMaxH3Transformer3DModel.load_config(str(BASE), subfolder=sub)
    conv = convert_minimax_h3_transformer_checkpoint_to_diffusers(sd, config=config, qkv_layout="stacked")
    with init_empty_weights():
        model = MiniMaxH3Transformer3DModel.from_config(config)
    missing, unexpected = model.load_state_dict(conv, assign=True, strict=False)
    missing = [k for k in missing if "rope" not in k]
    if missing or unexpected:
        raise RuntimeError(f"transformer keys: missing {missing[:5]} unexpected {unexpected[:5]}")
    for name, buf in list(model.named_buffers()):          # buffers left on the meta device are recomputed ones
        if buf.device.type == "meta":
            raise RuntimeError(f"buffer {name} was not restored")
    model.to(torch.bfloat16).eval().requires_grad_(False)
    for name in getattr(model, "_keep_in_fp32_modules", None) or []:   # small projections / time embedding compute in FP32
        for mname, mod in model.named_modules():
            if mname == name or mname.endswith("." + name):
                mod.to(torch.float32)
    log(f"transformer ready in {time.time() - t0:.0f}s")
    return model


def load_text_encoder():
    from accelerate import init_empty_weights
    from transformers import AutoConfig, Qwen3VLForConditionalGeneration
    t0 = time.time()
    sd = read_safetensors(FILES["te"])
    ren = {}
    for k, v in sd.items():
        if k.startswith("model."):
            k = "model.language_model." + k[len("model."):]
        elif k.startswith("visual."):
            k = "model." + k
        ren[k] = v
    layers = 1 + max(int(m.group(1)) for k in ren for m in [re.match(r"model\.language_model\.layers\.(\d+)\.", k)] if m)
    # one layer beyond the file: hidden_states[layers] is then a pre-norm output, as in the full 64-layer stack
    for k in [k for k in ren if k.startswith(f"model.language_model.layers.{layers - 1}.")]:
        ren[k.replace(f".layers.{layers - 1}.", f".layers.{layers}.")] = ren[k].clone()
    config = AutoConfig.from_pretrained(str(BASE / "text_encoder"))
    tc = config.text_config
    tc.num_hidden_layers = layers + 1
    if getattr(tc, "layer_types", None):
        tc.layer_types = tc.layer_types[: layers + 1]
    with init_empty_weights():
        model = Qwen3VLForConditionalGeneration._from_config(config, dtype=torch.bfloat16)
    model.lm_head = nn.Identity()
    # the final norm only touches the last hidden state, which H3 never reads; the single-file checkpoint drops it
    ren.setdefault("model.language_model.norm.weight", torch.ones(config.text_config.hidden_size, dtype=torch.bfloat16))
    missing, unexpected = model.load_state_dict(ren, assign=True, strict=False)
    missing = [k for k in missing if not k.startswith("lm_head")]
    if missing or unexpected:
        raise RuntimeError(f"text encoder keys: missing {missing[:5]} unexpected {unexpected[:5]}")
    for name, buf in list(model.named_buffers()):
        if buf.device.type == "meta":                        # rotary inv_freq: rebuild on CPU
            mod = model.get_submodule(name.rsplit(".", 1)[0])
            if hasattr(mod, "rope_init_fn"):
                inv, _ = mod.rope_init_fn(mod.config, torch.device("cpu"))
                mod.register_buffer("inv_freq", inv, persistent=False)
                mod.original_inv_freq = inv
    model.eval().requires_grad_(False)
    n = fp8_linears(model.model.language_model)
    log(f"text encoder ready: {layers}+1 layers, {n} FP8 linears, {time.time() - t0:.0f}s")
    return model


def pick_lora(task: str, height, width, turbo: bool) -> str | None:
    """The one rule for the turbo LoRA: 4-step 768p one from ~0.7 MP up, else the 8-step one (480p)."""
    if not turbo:
        return None
    if task == "ref2va":
        return "ref2va_4"
    return "fl2va_768" if int(height or 768) * int(width or 1344) >= 700_000 else "fl2va_8"


# --------------------------------------------------------------------------- the engine

class Engine:
    def __init__(self, resident_blocks: int = 0):
        from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3Blocks
        self.resident = resident_blocks
        t0 = time.time()
        self.pipe = MiniMaxH3Blocks().init_pipeline(str(BASE))
        names = [n for n in self.pipe.pretrained_component_names if n not in ("transformer", "transformer_ref", "text_encoder")]
        self.pipe.load_components(names=names, pretrained_model_name_or_path=str(BASE), torch_dtype=torch.bfloat16)
        log(f"small components {names} in {time.time() - t0:.0f}s")
        te = load_text_encoder()
        self.pipe.update_components(text_encoder=te)
        self._stream(te, "leaf_level")
        for n in ("vae", "audio_vae"):              # like ComfyUI: off the GPU while the transformer denoises
            gpu_while_used(getattr(self.pipe, n))
        self.task = None
        self.lora = None

    @staticmethod
    def _chunk_ff(model: nn.Module, rows: int = 16384):
        """Run every block's feed-forward over at most `rows` tokens at a time: same math, a fraction of the peak
        memory on long clips (the 768p 14 s sequence is ~100k tokens; its FFN intermediate alone is ~6 GB)."""
        for blk in getattr(model, "transformer_blocks", []):
            ff = getattr(blk, "ff", None)
            if ff is None or getattr(ff, "_h3_chunked", False):
                continue
            inner = ff.forward

            def fwd(x, *a, _inner=inner, **k):
                if x.dim() != 3 or x.shape[1] <= rows:
                    return _inner(x, *a, **k)
                return torch.cat([_inner(x[:, i:i + rows], *a, **k) for i in range(0, x.shape[1], rows)], dim=1)
            ff.forward = fwd
            ff._h3_chunked = True

    def _stream(self, module: nn.Module, kind: str, keep_first: int = 0):
        from diffusers.hooks import apply_group_offloading
        module.to("cpu")
        pin_module(module)
        apply_group_offloading(module, onload_device=DEV, offload_type=kind,
                               num_blocks_per_group=1 if kind == "block_level" else None, use_stream=True, low_cpu_mem_usage=True)

    def _drop_big(self):
        olds = []
        for n in ("transformer", "transformer_ref"):
            if getattr(self.pipe, n, None) is not None:
                olds.append(getattr(self.pipe, n)); self.pipe.update_components(**{n: None})
        if getattr(self, "ipipe", None) is not None and getattr(self.ipipe, "transformer", None) is not None:
            olds.append(self.ipipe.transformer); self.ipipe.update_components(transformer=None)
        for m in olds:
            release_module(m)
        del olds
        self.task = self.lora = None
        gc.collect(); torch.cuda.empty_cache()
        try:
            import ctypes; ctypes.CDLL("libc.so.6").malloc_trim(0)      # hand freed pages back to the OS
        except Exception:
            pass

    def image_ready(self) -> bool:
        return (IMG_BASE / "transformer_diffusers" / "config.json").exists() and not any(IMG_BASE.rglob("*.part"))

    def use_image(self):
        """H3-Image's transformer becomes the loaded big model (the video one leaves RAM)."""
        if self.task == "image":
            return
        from diffusers.modular_pipelines.minimax_h3_image import MiniMaxH3ImageBlocks
        from diffusers import MiniMaxH3ImageTransformer2DModel
        self._drop_big()
        t0 = time.time()
        if getattr(self, "ipipe", None) is None:
            self.ipipe = MiniMaxH3ImageBlocks().init_pipeline(str(IMG_BASE))
            names = [n for n in self.ipipe.pretrained_component_names if n not in ("transformer", "text_encoder")]
            self.ipipe.load_components(names=names, pretrained_model_name_or_path=str(IMG_BASE), torch_dtype=torch.bfloat16)
            self.ipipe.update_components(text_encoder=self.pipe.text_encoder)
            gpu_while_used(self.ipipe.vae)
        need_ram(70, " H3-Image")
        model = MiniMaxH3ImageTransformer2DModel.from_pretrained(str(IMG_BASE), subfolder="transformer_diffusers", torch_dtype=torch.bfloat16)
        model.eval().requires_grad_(False)
        self._chunk_ff(model)
        self._stream(model, "block_level")
        self.ipipe.update_components(transformer=model)
        self.task = "image"
        log(f"H3-Image transformer ready in {time.time() - t0:.0f}s")

    @torch.inference_mode()
    def generate_image(self, prompt: str, out: str, images=None, height: int = 2048, width: int = 2048, steps: int | None = None, seed: int = 0):
        self.use_image()
        kw = dict(prompt=prompt, height=height, width=width, generator=torch.Generator().manual_seed(seed), output="images")
        if images:
            kw["image"] = images if len(images) > 1 else images[0]
        if steps:
            kw["num_inference_steps"] = steps
        t0 = time.time()
        r = self.ipipe(**kw)
        img = r[0] if isinstance(r, list) else r
        img.save(out)
        log(f"image {out}: {time.time() - t0:.0f}s")
        return time.time() - t0

    def use(self, task: str, lora: str | None):
        """Make `task`'s transformer (with `lora` fused) the loaded one; the other one leaves RAM."""
        if (self.task, self.lora) == (task, lora):
            return
        self._drop_big()
        need_ram(70, " H3 视频模型")
        model = load_transformer(task, lora)
        self._chunk_ff(model)
        self._stream(model, "block_level")
        self.pipe.update_components(**{("transformer_ref" if task == "ref2va" else "transformer"): model})
        self.task, self.lora = task, lora

    @torch.inference_mode()
    def generate(self, prompt: str, out: str, image=None, last_image=None, references=None, seconds: float = 5.2,
                 height=None, width=None, steps: int = 4, seed: int = 0, turbo: bool = True, frames: int | None = None,
                 lora: str | None = "auto"):
        from diffusers.utils.export_utils import encode_video
        task = "ref2va" if references else "fl2va"
        if lora == "auto":                                # callers that already chose (the service) pass their choice
            lora = pick_lora(task, height, width, turbo)
        self.use(task, lora)
        if not frames:                                   # the VAE's 17n+5 grid, at least 5.2 s
            frames = max(124, round(seconds * 24))
            frames += (5 - frames % 17) % 17
        # diffusers counts grid points (terminal 0 included): `steps` model evaluations need steps + 1, like ComfyUI's steps
        # H3 takes 120..360 frames on the VAE's 17n+5 grid: 124 (5.2 s) .. 345 (14.4 s); 15 s would round up to 362
        frames = min(345, max(124, int(frames)))
        frames += (5 - frames % 17) % 17
        frames = min(frames, 345)
        kw = dict(prompt=prompt, num_frames=frames, num_inference_steps=steps + 1,
                  generator=torch.Generator().manual_seed(seed), output=["videos", "audio", "sampling_rate"])
        if height and width:
            kw.update(height=height, width=width)
        if image is not None:
            kw["image"] = image
        if last_image is not None:
            kw["last_image"] = last_image
        if references:
            kw["references"] = references
        t0 = time.time()
        torch.cuda.reset_peak_memory_stats()
        r = self.pipe(**kw)
        took = time.time() - t0
        encode_video(r["videos"][0], fps=24, output_path=out, audio=r["audio"][0], audio_sample_rate=r["sampling_rate"])
        log(f"generated {out}: {took:.0f}s, peak VRAM {torch.cuda.max_memory_allocated() / 2**30:.1f} GiB")
        return took


if __name__ == "__main__":
    import sys
    e = Engine()
    for i, p in enumerate(sys.argv[1:] or ["雨夜的公交站，一个穿米色风衣的年轻女人站在站台下，抬头看向镜头，雨水顺着站牌滴落，霓虹灯在湿漉漉的地面上反光。环境音：雨声和远处的车声。"]):
        e.generate(p, f"/tmp/h3e_{i}.mp4", height=768, width=1344, steps=4)
