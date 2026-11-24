"""Run the ConvRot checkpoint in ComfyUI while the native engine owns the GPU queue."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
from tempfile import TemporaryDirectory
import uuid

import aiohttp

MODEL = "h3-video-ref2va-int8-convrot"
LABEL = "H3 Ref2VA INT8 ConvRot"
WEIGHTS = "MiniMax-H3_Ref2VA-INT8-ConvRot.safetensors"
COMFY_HOME = Path(os.environ.get("H3_INT8_COMFY_DIR", Path.home() / "ComfyUI"))
MODELS = Path(os.environ.get("H3_INT8_MODELS", Path(__file__).resolve().parents[1] / "models/h3-int8"))
ASSETS = {
    f"diffusion_models/{WEIGHTS}": 22484075856,
    "vae/minimax_h3_video_vae_fp16.safetensors": 5207808496,
    "vae/minimax_h3_audio_vae_fp32.safetensors": 605254808,
}


def comfy_python():
    launcher = MODELS / "comfy-python"
    return Path(os.environ.get("H3_INT8_PYTHON", launcher if launcher.is_file() else COMFY_HOME / ".venv/bin/python"))


def installed():
    try:
        return os.access(comfy_python(), os.X_OK) and (COMFY_HOME / "main.py").is_file() and all(
            (MODELS / name).stat().st_size == size for name, size in ASSETS.items()
        )
    except OSError:
        return False


def run(graph, out, media_dir, seed, report, cancelled):
    if not installed():
        raise RuntimeError("H3 INT8 ConvRot 权重或运行环境尚未安装")
    if cancelled():
        raise InterruptedError()
    target = Path(out)
    target.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="oneshot-h3-int8-") as temp:
        work = Path(temp)
        output = work / "output"
        config = work / "models.yaml"
        config.write_text(json.dumps({"h3_int8": {"base_path": str(MODELS), "diffusion_models": "diffusion_models", "vae": "vae"}}))
        graph["7"]["inputs"]["noise_seed"] = seed
        graph["15"]["inputs"].update(filename_prefix="video")  # SaveVideo's auto format is MP4/H.264
        inputs = work / "input"
        inputs.mkdir()
        media = Path(media_dir)
        for key, node in graph.items():
            if node["class_type"] == "LoadImage":
                name = node["inputs"]["image"]
                kind = "output" if name.endswith(" [output]") else "input"
                folder = (media / kind).resolve()
                source = (folder / name.removesuffix(" [output]")).resolve()
                if not source.is_relative_to(folder):
                    raise ValueError("参考图路径无效")
                filename = f"{key}{source.suffix}"
                shutil.copyfile(source, inputs / filename)
                node["inputs"]["image"] = filename
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        command = [str(comfy_python()), str(COMFY_HOME / "main.py"), "--listen", "127.0.0.1", "--port", str(port),
                   "--input-directory", str(inputs), "--output-directory", str(output), "--temp-directory", str(work / "temp"),
                   "--user-directory", str(work), "--extra-model-paths-config", str(config), "--disable-all-custom-nodes",
                   "--offline", "--disable-assets", "--disable-metadata", "--disable-pinned-memory"]
        report("loading", 0, graph["9"]["inputs"]["steps"])
        with subprocess.Popen(command, cwd=COMFY_HOME) as proc:
            try:
                video = asyncio.run(generate(proc, port, graph, output, report, cancelled))
                if cancelled():
                    raise InterruptedError()
                # A partial copy must never appear under the public output name.
                staging = target.with_suffix(".mp4.part")
                try:
                    shutil.copyfile(video, staging)
                    if cancelled():
                        raise InterruptedError()
                    staging.replace(target)
                finally:
                    staging.unlink(missing_ok=True)
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()


async def generate(proc, port, graph, output, report, cancelled):
    address = f"http://127.0.0.1:{port}"
    client_id = uuid.uuid4().hex
    steps = graph["9"]["inputs"]["steps"]

    def check_process():
        if cancelled():
            raise InterruptedError()
        if proc.poll() is not None:
            raise RuntimeError(f"H3 INT8 ComfyUI 进程退出（{proc.returncode}）")

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10), base_url=address) as http:
        async with asyncio.timeout(90):
            while True:
                check_process()
                try:
                    async with http.get("/system_stats") as response:
                        if response.ok:
                            break
                except aiohttp.ClientConnectorError:
                    pass
                await asyncio.sleep(0.5)

        async with http.ws_connect("/ws", params={"clientId": client_id}) as ws:
            async with http.post("/prompt", json={"prompt": graph, "client_id": client_id}) as response:
                body = await response.json()
                if not response.ok or not body.get("prompt_id"):
                    raise RuntimeError(f"H3 INT8 工作流提交失败：{json.dumps(body, ensure_ascii=False)}")
            job_id = body["prompt_id"]
            async with asyncio.timeout(3600):
                while True:
                    check_process()
                    try:
                        message = await ws.receive(timeout=1)
                    except asyncio.TimeoutError:
                        continue
                    if message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        raise RuntimeError("H3 INT8 ComfyUI 连接中断")
                    if message.type != aiohttp.WSMsgType.TEXT:
                        continue
                    event = message.json()
                    data = event.get("data", {})
                    if data.get("prompt_id") != job_id:
                        continue
                    if event["type"] == "progress" and str(data.get("node")) == "11":
                        report("sampling", data["value"], data["max"])
                    elif event["type"] == "executing":
                        phase = {"5": "encoding", "11": "sampling", "12": "decoding", "13": "decoding"}.get(str(data.get("node")))
                        if phase:
                            report(phase, steps if phase == "decoding" else 0, steps)
                        if data.get("node") is None:
                            break

        async with http.get(f"/history/{job_id}") as response:
            response.raise_for_status()
            result = (await response.json()).get(job_id, {})
        status = result.get("status", {})
        if status.get("status_str") != "success":
            reason = next((details.get("exception_message") for kind, details in status.get("messages", []) if kind == "execution_error"), None)
            raise RuntimeError(reason or "H3 INT8 视频生成失败")
        files = result.get("outputs", {}).get("15", {}).get("images", [])
        if len(files) != 1:
            raise RuntimeError("H3 INT8 没有返回视频文件")
        video = (output / files[0].get("subfolder", "") / files[0]["filename"]).resolve()
        if not video.is_relative_to(output) or video.suffix != ".mp4" or not video.is_file():
            raise RuntimeError("H3 INT8 返回的视频文件无效")
        return video
