"""Read H3 checkpoints and merge LoRA weights before model conversion."""

from pathlib import Path

import torch


DEV = torch.device("cuda")


def mmap_safetensors(path: Path) -> dict:
    """Tensors that read straight from the file (page cache), never copied into process memory — how ComfyUI keeps a
    51 GB text encoder next to a 62 GB transformer in 125 GB of RAM: the kernel can drop and re-read these pages."""
    import json, struct
    import numpy as np
    dt = {"BF16": (np.uint16, torch.bfloat16), "F16": (np.float16, torch.float16), "F32": (np.float32, torch.float32),
          "I64": (np.int64, torch.int64), "I32": (np.int32, torch.int32), "U8": (np.uint8, torch.uint8), "I8": (np.int8, torch.int8)}
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))
    header.pop("__metadata__", None)
    mm = np.memmap(path, dtype=np.uint8, mode="r", offset=8 + n)
    out = {}
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")                      # read-only mapping: torch warns that it is not writable
        for k, v in header.items():
            npt, tt = dt[v["dtype"]]
            a, b = v["data_offsets"]
            arr = mm[a:b].view(npt).reshape(v["shape"]) if v["shape"] else mm[a:b].view(npt).reshape(())
            t = torch.from_numpy(arr)
            out[k] = t.view(tt) if tt == torch.bfloat16 else t
    return out


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
