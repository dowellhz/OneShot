"""Optional image models that run on the shared H3 GPU queue."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

MODELS_DIR = Path(os.environ.get(
    "ONESHOT_IMAGE_MODELS", Path(__file__).resolve().parents[1] / "models" / "image",
))


@dataclass(frozen=True)
class ImageModel:
    label: str
    repo: str
    revision: str
    pipeline: str
    references: int
    steps: int
    high_resolution: bool = False


MODELS = {
    "qwen-image-2.1": ImageModel(
        "Qwen-Image-2.1", "Qwen/Qwen-Image-2.1", "d26bb61231c349cf6b7896fa83353113880e1ba3",
        "QwenImage21Pipeline", 6, 40, high_resolution=True,
    ),
    "flux-2-klein-4b": ImageModel(
        "FLUX.2 [klein] 4B", "black-forest-labs/FLUX.2-klein-4B", "e7b7dc27f91deacad38e78976d1f2b499d76a294",
        "Flux2KleinPipeline", 4, 4,
    ),
}


def installed(model: str) -> bool:
    return isinstance(model, str) and model in MODELS and all(
        (MODELS_DIR / model / file).is_file() for file in ("model_index.json", ".oneshot-ready")
    )


def generate(request: dict, images: list, progress, cancelled) -> None:
    import diffusers
    import torch

    model_id = request["image_model"]
    model = MODELS[model_id]
    if len(images) > model.references:
        raise ValueError(f"{model.label} supports up to {model.references} reference images")
    if cancelled():
        return

    progress("loading", 0, model.steps)
    pipeline = getattr(diffusers, model.pipeline).from_pretrained(
        str(MODELS_DIR / model_id), torch_dtype=torch.bfloat16, local_files_only=True,
    )
    pipeline.enable_model_cpu_offload()

    def on_step(_pipeline, step, _timestep, kwargs):
        if cancelled():
            raise InterruptedError("已取消")
        progress("sampling", step + 1, model.steps)
        return kwargs

    options = {
        "prompt": request["prompt"], "height": request["height"], "width": request["width"],
        "num_inference_steps": model.steps,
        "generator": torch.Generator(device="cuda").manual_seed(request["seed"]),
        "callback_on_step_end": on_step,
    }
    if images:
        options["image"] = images
    if model.pipeline == "Flux2KleinPipeline":
        options["guidance_scale"] = 1.0
    else:
        options["output_resolution"] = 2048 if request["height"] * request["width"] > 2_000_000 else 1024
        pipeline.vae.enable_tiling()
    if cancelled():
        return
    progress("encoding", 0, model.steps)
    try:
        with torch.inference_mode():
            result = pipeline(**options).images[0]
        if not cancelled():
            result.save(request["out"])
    finally:
        pipeline.maybe_free_model_hooks()
