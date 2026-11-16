"""MiniMax-H3-Image "pruned" checkpoint (Comfy-Org/MiniMax-H3-Image, 40 GB BF16) on diffusers' transformer.

The pruned file differs from the full one in a single place, and nothing is quantized:
the time embedding silu(time_embedder(t)) only depends on the scalar t, so every AdaLN projection of it is a curve in
t. The checkpoint stores that curve on an 8-dim basis sampled on a 1025-point grid (`adaln_t_table`), and each AdaLN
linear maps the 8 basis coordinates (no silu) instead of the 2688-dim embedding — 26 GB of AdaLN weights become MBs.
This is ComfyUI's `use_adaln_curves` path, reproduced here:
    temb  = lerp(table[floor(t*1024)], table[+1], frac)          [M, 8] fp32
    adaln = linear_fp32(temb)                                     (no silu)
The 6 PDD output heads ship as a bank: block 0 is a full head, block k>0 is an offset from it; a 6-step schedule
uses one head per step, so diffusers' head k = block0 + block k (ComfyUI `_pdd_head` with one interval).
"""
from __future__ import annotations

import time
from pathlib import Path

import torch
import torch.nn as nn


class CurveTable(nn.Module):
    """Stands in for `time_embedder`: t in [0,1] -> interpolated row of the curve table (float32)."""

    def __init__(self, table: torch.Tensor):
        super().__init__()
        self.table = nn.Parameter(table.to(torch.float32), requires_grad=False)

    def forward(self, t):
        table = self.table
        pos = t.to(torch.float32).clamp(0.0, 1.0) * (table.shape[0] - 1)
        i0 = pos.floor().long().clamp(max=table.shape[0] - 2)
        return torch.lerp(table[i0], table[i0 + 1], (pos - i0).unsqueeze(1))


def _adaln_forward(self, temb):
    # MiniMaxH3ImageAdaLayerNormModulation without the silu, fp32 like ComfyUI's adaln_dtype; rows go to the
    # block's dtype the way ComfyUI's _mod_row casts them
    x = nn.functional.linear(temb.to(torch.float32), self.linear.weight, self.linear.bias).to(torch.bfloat16)
    return x.view(-1, 6 * self.hidden_size).chunk(6, dim=-1)


def _norm_out_forward(self, hidden_states, temb, timestep_indices):
    shift, scale = nn.functional.linear(temb.to(torch.float32), self.linear.weight, self.linear.bias).chunk(2, dim=-1)
    hidden_states = self.norm(hidden_states)
    return hidden_states * (1.0 + scale.index_select(0, timestep_indices)) + shift.index_select(0, timestep_indices)


def load_pruned_image(path: Path, base_dir: str, sub: str, read=None, log=print):
    """The pruned checkpoint as a MiniMaxH3ImageTransformer2DModel on the CPU (bf16, fp32 islands), ready to stream."""
    import types
    from accelerate import init_empty_weights
    from diffusers import MiniMaxH3ImageTransformer2DModel as C
    from diffusers.loaders.single_file_utils import convert_minimax_h3_transformer_checkpoint_to_diffusers as conv
    t0 = time.time()
    if read is None:
        from safetensors.torch import load_file as read
    ck = read(str(path))
    table = ck.pop("adaln_t_table")
    for k in [k for k in ck if k.endswith("comfy_attention.config")]:
        del ck[k]
    config = dict(C.load_config(base_dir, subfolder=sub))
    config["time_embed_dim"] = table.shape[1]
    with init_empty_weights():
        model = C.from_config(config)
    sd = conv(ck, config=config, qkv_layout="stacked")
    del ck
    W, b = sd.pop("proj_out.weight"), sd.pop("proj_out.bias")
    n = len(model.pdd_proj_out)
    W, b = W.reshape(n, -1, W.shape[1]).float(), b.reshape(n, -1).float()
    for k in range(n):
        sd[f"pdd_proj_out.{k}.weight"] = W[0] + W[k] if k else W[0].clone()
        sd[f"pdd_proj_out.{k}.bias"] = b[0] + b[k] if k else b[0].clone()
    missing, unexpected = model.load_state_dict(sd, assign=True, strict=False)
    missing = [k for k in missing if not k.startswith("time_embedder.")]
    if missing or unexpected:
        raise RuntimeError(f"pruned H3-Image: missing {missing[:5]}, unexpected {unexpected[:5]}")
    model.time_proj = nn.Identity()
    model.time_embedder = CurveTable(table)
    fp32 = tuple(getattr(model, "_keep_in_fp32_modules", None) or ())
    for name, p in model.named_parameters():
        keep = name.startswith(fp32) or ".adaln_proj." in name or name.startswith(("norm_out.linear.", "time_embedder."))
        p.data = p.data.to(torch.float32 if keep else torch.bfloat16)
    for blk in model.transformer_blocks:
        blk.adaln_proj.forward = types.MethodType(_adaln_forward, blk.adaln_proj)
    model.norm_out.forward = types.MethodType(_norm_out_forward, model.norm_out)
    model.eval().requires_grad_(False)
    log(f"H3-Image pruned (curve AdaLN, BF16) loaded in {time.time() - t0:.0f}s")
    return model
