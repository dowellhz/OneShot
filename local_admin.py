"""本地部署: status and control of what runs on this 4090 — GPU, the H3 engine (ComfyUI core), the Qwen prompt model,
the Kokoro voice worker, the DeepSeek web service that shares the GPU, model files and their downloads.

The H3 engine and the DeepSeek web cannot hold the GPU at the same time; switching is one action that stops one and
starts the other (the same steps as ~/ComfyUI/start-comfyui.sh / stop-comfyui.sh, minus restarting this server).
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import aiohttp
from aiohttp import web

HOME = Path.home()
COMFY_DIR = HOME / "ComfyUI"
MODEL_DIRS = [Path("/d2/Lego/minimax-h3"), Path("/d2/Lego/llm/qwen3.5-9b")]
DS_SERVICE = HOME / "InferSSD/experiment/web/service.json"
DS_START = HOME / "InferSSD/experiment/start_deepseek_web_after_test.py"
ROOT = Path(__file__).resolve().parent
ENGINE_SH = ROOT / "engine.sh"

routes = web.RouteTableDef()
_busy = {"action": None, "since": 0, "log": ""}


def sh(cmd: list[str], timeout=10) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


def gpu() -> dict:
    out = sh(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit",
              "--format=csv,noheader,nounits"])
    try:
        n, mu, mt, ut, te, pd, pl = [x.strip() for x in out.strip().splitlines()[0].split(",")]
        procs = []
        for ln in sh(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]).strip().splitlines():
            pid, mem = [x.strip() for x in ln.split(",")]
            try:
                cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()[:160]
            except Exception:
                cmd = "?"
            procs.append({"pid": int(pid), "mem": int(mem), "what": who_is(cmd)})
        return {"name": n, "mem_used": int(mu), "mem_total": int(mt), "util": int(ut), "temp": int(te), "power": float(pd), "power_limit": float(pl), "procs": procs}
    except Exception:
        return {"error": "读不到 GPU（nvidia-smi）"}


def who_is(cmd: str) -> str:
    if "service.py" in cmd and "h3engine" in cmd:
        return "H3 引擎"
    if "main.py" in cmd and "ComfyUI" in cmd or cmd.startswith(".venv/bin/python main.py"):
        return "旧 ComfyUI"
    if "llama-server" in cmd:
        return "Qwen 提示词模型" if "qwen" in cmd.lower() else "llama-server"
    if "serve_deepseek" in cmd or "InferSSD" in cmd:
        return "DeepSeek 网页"
    return cmd.split(" ")[0].split("/")[-1]


def mem() -> dict:
    d = {}
    for ln in Path("/proc/meminfo").read_text().splitlines():
        k, v = ln.split(":", 1)
        d[k] = int(v.split()[0]) // 1024
    return {"total": d["MemTotal"], "available": d["MemAvailable"]}


def disks() -> list[dict]:
    out = []
    for p in ("/", "/d2", "/d3"):
        try:
            u = shutil.disk_usage(p)
            out.append({"path": p, "total": u.total, "free": u.free})
        except Exception:
            pass
    return out


def ds_web() -> dict:
    try:
        s = json.loads(DS_SERVICE.read_text())
    except Exception:
        return {"known": False}
    pid = s.get("controller_pid")
    alive = False
    try:
        alive = bool(pid) and Path("/proc", str(pid)).exists() and Path("/proc", str(pid), "stat").read_text().split()[21] == str(s.get("controller_start_identity"))
    except Exception:
        pass
    return {"known": True, "running": alive, "url": s.get("url"), "model": s.get("model"), "status": s.get("status") if alive else "stopped"}


def comfy_pid() -> int | None:
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        try:
            cmd = (p / "cmdline").read_bytes().split(b"\0")
            if b"main.py" in cmd and os.readlink(p / "cwd") == str(COMFY_DIR):
                return int(p.name)
        except Exception:
            continue
    return None


def models() -> list[dict]:
    out = []
    for d in MODEL_DIRS:
        if not d.is_dir():
            continue
        for f in sorted(d.rglob("*")):
            if f.is_file() and f.suffix in (".safetensors", ".gguf", ".pth", ".part") and f.stat().st_size > 50 << 20:
                out.append({"path": str(f), "name": f.name, "dir": f.parent.name, "size": f.stat().st_size, "mtime": f.stat().st_mtime,
                            "downloading": f.suffix == ".part" and time.time() - f.stat().st_mtime < 120})
    return out


@routes.get("/api/admin/local")
async def local_status(req):
    llm = req.app["llm"]
    import tts
    eng = {}
    try:
        async with req.app["http"].get("http://127.0.0.1:8189/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
            eng = await r.json()
    except Exception:
        pass
    comfy_old = comfy_pid() is not None
    return web.json_response({
        "gpu": gpu(), "mem": mem(), "disks": disks(), "models": models(), "busy": _busy,
        "services": {
            "engine": {"running": bool(eng), "ready": eng.get("ready"), "loading": eng.get("loading"), "error": eng.get("error"),
                       "loaded": eng.get("loaded"), "queue": eng.get("queue", 0), "busy": bool(eng.get("running")),
                       "image_ready": eng.get("image_ready"), "vram": eng.get("vram_used_gb")},
            "comfy_old": comfy_old,
            "qwen": {"installed": llm.local_ok(), "running": llm.running(), "device": llm.device if llm.running() else None},
            "kokoro": {"installed": tts.available(), "running": bool(tts._proc and tts._proc.returncode is None)},
            "deepseek": ds_web(),
        }})


async def _run(action: str, args: list[str]):
    _busy.update(action=action, since=time.time(), log="")
    try:
        p = await asyncio.create_subprocess_exec("bash", str(ENGINE_SH), *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await asyncio.wait_for(p.communicate(), 600)
        _busy["log"] = out.decode(errors="replace")[-2000:]
    except Exception as e:
        _busy["log"] = f"失败：{e}"
    finally:
        _busy["action"] = None


@routes.post("/api/admin/local/{action}")
async def local_action(req):
    a = req.match_info["action"]
    if _busy["action"]:
        return web.json_response({"error": f"正在{_busy['action']}，请稍等"}, status=400)
    if a == "engine-start":
        asyncio.create_task(_run("启动 H3 引擎（会先停掉 DeepSeek 网页）", ["engine-start"]))
    elif a == "engine-stop":
        asyncio.create_task(_run("停止 H3 引擎", ["engine-stop"]))
    elif a == "to-deepseek":
        asyncio.create_task(_run("把显卡切给 DeepSeek 网页", ["engine-stop", "deepseek-start"]))
    elif a == "qwen-stop":
        req.app["llm"].stop()
    elif a == "kokoro-stop":
        import tts
        tts.stop()
    elif a == "free-vram":
        async with req.app["http"].post("http://127.0.0.1:8189/free", json={}):
            pass
    elif a == "comfy-stop":
        asyncio.create_task(_run("停止旧的 ComfyUI", ["comfy-stop"]))
    else:
        return web.json_response({"error": "未知操作"}, status=400)
    return web.json_response({"ok": True})
