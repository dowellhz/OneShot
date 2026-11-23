#!/usr/bin/env python3
"""Prepare OneShot editor models on the deployment host; verifies every downloaded weight.

Run from the existing H3 Python environment. CPU cutout dependencies get their own venv.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPOSITORIES = {"sam2": "facebook/sam2.1-hiera-tiny", "inpaint": "AI-ModelScope/stable-diffusion-inpainting"}
UPSCALE_RELEASE = "https://raw.githubusercontent.com/Saafke/FSRCNN_Tensorflow/6a4812c4ef1c4f5947d79beafa32a05a6eb4a94d/models/"
UPSCALE_CHECKSUMS = {
    "FSRCNN_x2.pb": "366b33f0084c7b3f2bf6724f0a2c77bca94fcec9d7b6d72389d330073b380d5c",
    "FSRCNN_x4.pb": "5c68d18db561aed8ead4ffedf1b897ea615baaf60ebf6c35f8e641f8fa4a21bf",
}


def fetch_upscale(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, checksum in UPSCALE_CHECKSUMS.items():
        path = directory / name
        if path.is_file() and digest(path) == checksum:
            continue
        with urllib.request.urlopen(UPSCALE_RELEASE + name, timeout=30) as response:
            weights = response.read()
        if hashlib.sha256(weights).hexdigest() != checksum:
            raise RuntimeError("超分模型校验失败：" + name)
        with tempfile.NamedTemporaryFile(dir=directory, suffix=".part", delete=False) as output:
            partial = Path(output.name)
            output.write(weights)
        partial.replace(path)
        print("ready upscale", name, flush=True)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def fetch_file(item):
    model, repo, file, directory = item
    path = directory / model / file["Path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size == file["Size"] and digest(path) == file["Sha256"]:
        return
    partial = path.with_suffix(path.suffix + ".part")
    url = f"https://modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath=" + urllib.parse.quote(file["Path"], safe="")
    for attempt in range(8):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            req = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
            with urllib.request.urlopen(req, timeout=45) as response, partial.open("ab" if offset and response.status == 206 else "wb") as output:
                while block := response.read(1024 * 1024):
                    output.write(block)
            if partial.stat().st_size != file["Size"] or digest(partial) != file["Sha256"]:
                partial.unlink(missing_ok=True)
                raise RuntimeError("文件校验失败")
            partial.replace(path)
            print("ready", model, file["Path"], flush=True)
            return
        except Exception:
            if attempt == 7:
                raise
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", type=Path, default=ROOT / "models")
    parser.add_argument("--with-u2net", action="store_true", help="Optional isolated U²-Netp background-removal backend")
    parser.add_argument("--upscale-only", action="store_true", help="Download only the 2× and 4× FSRCNN models")
    args = parser.parse_args()
    if args.upscale_only:
        fetch_upscale(args.models_dir / "upscale")
        return
    files, manifest = [], {}
    for model, repo in REPOSITORIES.items():
        with urllib.request.urlopen(f"https://modelscope.cn/api/v1/models/{repo}/repo/files?Recursive=true&Revision=master", timeout=30) as response:
            metadata = json.load(response)
        selected = [f for f in metadata["Data"]["Files"] if f.get("Type") == "blob" and (
            f["Path"].endswith(".json") or (model == "sam2" and f["Path"] == "model.safetensors")
            or f["Path"].endswith(".fp16.safetensors") or f["Path"].startswith("tokenizer/"))]
        if not selected:
            raise RuntimeError("模型目录为空：" + repo)
        manifest[model] = {"repository": repo, "sha256": {f["Path"]: f["Sha256"] for f in selected}}
        files += [(model, repo, f, args.models_dir) for f in selected]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(fetch_file, files))
    args.models_dir.mkdir(parents=True, exist_ok=True)
    (args.models_dir / "editor-models.json").write_text(json.dumps(manifest, indent=2))
    if args.with_u2net:
        venv = ROOT / "editor-venv"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        subprocess.run([str(venv / "bin/python"), "-m", "pip", "install", "-r", str(ROOT / "requirements-editor.txt")], check=True)
        code = "from rembg import new_session; new_session('u2netp', providers=['CPUExecutionProvider'])"
        subprocess.run([str(venv / "bin/python"), "-c", code], check=True, env={**os.environ, "U2NET_HOME": str(args.models_dir / "rembg")})
    print("Editor models are ready. Restart the idle engine to expose the new capabilities.")


if __name__ == "__main__":
    main()
