#!/usr/bin/env python3
"""Install optional image checkpoints for the existing engine environment."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from fnmatch import fnmatch
from pathlib import Path
import sys

from huggingface_hub import HfApi, snapshot_download

from fetch_editor_models import fetch_file

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import image_models

PIPELINE_FILES = [
    "model_index.json", "LICENSE*", "scheduler/*", "processor/*",
    "text_encoder/*", "tokenizer/*", "transformer/*", "vae/*",
]


def fetch_mirror_weights(model_id, model):
    info = HfApi().model_info(model.repo, revision=model.revision, files_metadata=True)
    files = [file for file in info.siblings if file.rfilename.endswith(".safetensors")
             and any(fnmatch(file.rfilename, pattern) for pattern in PIPELINE_FILES)]
    if not files or any(not file.lfs for file in files):
        raise RuntimeError(f"Missing upstream checksums for {model.label}")
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch_file, (
            (model_id, model.repo, {"Path": file.rfilename, "Size": file.lfs.size, "Sha256": file.lfs.sha256},
             image_models.MODELS_DIR)
            for file in files
        )))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--modelscope", action="store_true", help="Download weights via ModelScope and verify upstream hashes")
    parser.add_argument("models", nargs="+", choices=tuple(image_models.MODELS))
    args = parser.parse_args()
    for model_id in args.models:
        if image_models.installed(model_id):
            print(f"{model_id} already installed", flush=True)
            continue
        model = image_models.MODELS[model_id]
        target = image_models.MODELS_DIR / model_id
        print(f"Installing {model.label} in {target}", flush=True)
        snapshot_download(
            repo_id=model.repo, revision=model.revision, local_dir=target, max_workers=4,
            allow_patterns=PIPELINE_FILES,
            ignore_patterns=["*.safetensors"] if args.modelscope else None,
        )
        if args.modelscope:
            fetch_mirror_weights(model_id, model)
        if not (target / "model_index.json").is_file():
            raise RuntimeError(f"{model.label} pipeline metadata is missing")
        (target / ".oneshot-ready").touch()
        print(f"{model.label} installed", flush=True)


if __name__ == "__main__":
    main()
