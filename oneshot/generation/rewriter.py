"""Local prompt rewriter: Qwen3.5-9B (llama.cpp llama-server, vision via mmproj) turning a Chinese scene description
plus the canvas's reference images into MiniMax H3's official structured English prompt (the role H3-Context-IR plays
in MiniMax's hosted pipeline), and expanding H3-Image prompts.

The server starts on demand and stops after an idle spell. It runs on the GPU: before starting it asks ComfyUI to free
its VRAM cache when ComfyUI's queue is idle, and the canvas stops it before submitting a generation; while ComfyUI is
busy it runs on the CPU instead.
"""
import asyncio, base64, io, json, os, re, signal, subprocess, time
from pathlib import Path

import aiohttp

from oneshot.config import DATA_DIR, ROOT

HOME = Path.home()
LLAMA = Path(os.environ.get("H3_LLAMA_SERVER", str(HOME / "llama.cpp/build/bin/llama-server")))
MODEL = Path(os.environ.get("H3_LLM_MODEL", "/d2/Lego/llm/qwen3.5-9b/Qwen3.5-9B-Q6_K.gguf"))
MMPROJ = Path(os.environ.get("H3_LLM_MMPROJ", "/d2/Lego/llm/qwen3.5-9b/mmproj-F16.gguf"))
PORT = int(os.environ.get("H3_LLM_PORT", "8192"))
IDLE_S = 300
SETTINGS = DATA_DIR / "settings.json"


def load_remote() -> dict:
    """Remote OpenAI-compatible LLM (DeepSeek API etc.) for text-only work; set in the canvas's AI 设置."""
    try:
        r = json.loads(SETTINGS.read_text()).get("llm") or {}
    except Exception:
        return {}
    return r if r.get("enabled") and r.get("base_url") and r.get("model") else {}


def has_image(content) -> bool:
    return isinstance(content, list) and any(isinstance(p, dict) and p.get("type") == "image_url" for p in content)


def flatten(content) -> str:
    return content if isinstance(content, str) else "\n".join(p.get("text", "") for p in content if isinstance(p, dict))


async def remote_chat(http, cfg: dict, system: str, content, max_tokens=2000, temperature=0.6) -> str:
    url = cfg["base_url"].rstrip("/")
    url = url + ("/chat/completions" if url.endswith("/v1") or "deepseek.com" in url else "/v1/chat/completions")
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = "Bearer " + cfg["api_key"]
    body = {"model": cfg["model"], "messages": [{"role": "system", "content": system}, {"role": "user", "content": flatten(content)}],
            "max_tokens": max_tokens, "temperature": temperature, "stream": False}
    if "deepseek.com" in url:
        body["thinking"] = {"type": "disabled"}       # V4.1 thinks by default; we want speed
        if body["model"] in ("deepseek-chat", "deepseek-reasoner"):
            body["model"] = "deepseek-flash"          # retired 2026-07-24
    async with http.post(url, json=body, headers=headers, timeout=aiohttp.ClientTimeout(total=300)) as r:
        j = await r.json(content_type=None)
        if r.status != 200 or "choices" not in j:
            err = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else j.get("error") or j
            raise RuntimeError(f"{cfg.get('name') or 'DeepSeek'} 返回错误（{r.status}）：{str(err)[:300]}")
    text = j["choices"][0]["message"].get("content") or ""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


class LLM:
    def __init__(self, comfy_url: str, http_getter):
        self.comfy = comfy_url
        self.http = http_getter
        self.proc = None
        self.device = None
        self.last = 0.0
        self.lock = asyncio.Lock()
        self.via = None              # who answered the last chat: "GPU" / "CPU" (local Qwen) or the remote's name

    def local_ok(self) -> bool:
        return LLAMA.is_file() and MODEL.is_file()

    def local_vision_available(self) -> bool:
        return self.local_ok() and MMPROJ.is_file()

    async def local_vision(self, system, content, max_tokens=550, temperature=0.1, *, response_schema=None):
        return await self._local_chat(system, content, max_tokens, temperature, force_cpu=True,
                                      response_schema=response_schema)

    async def release_gpu(self):
        async with self.lock:
            if self.running() and self.device == "GPU":
                await asyncio.to_thread(self.stop)

    def available(self) -> bool:
        from oneshot.providers import catalog as providers
        return self.local_ok() or any(r["provider"]["kind"] != "local_qwen" for c in ("text", "vision") for r in providers.routes(c))

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    async def comfy_idle(self) -> bool:
        """The GPU is free for Qwen when the H3 engine is idle (it then holds ~7 GB; Qwen needs ~9 GB of the 24)."""
        try:
            async with self.http().get("http://127.0.0.1:8189/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
                s = await r.json()
            return not s.get("running") and not s.get("queue")
        except Exception:
            pass
        try:
            async with self.http().get(f"{self.comfy}/queue", timeout=aiohttp.ClientTimeout(total=2)) as r:
                q = await r.json()
            return not q.get("queue_running") and not q.get("queue_pending")
        except Exception:
            return False

    async def start(self, *, force_cpu=False):
        if self.running():
            return
        gpu = not force_cpu and await self.comfy_idle()
        if gpu:   # an old ComfyUI engine, if one still runs, drops its VRAM cache; the H3 engine leaves room by itself
            try:
                async with self.http().post(f"{self.comfy}/free", json={"unload_models": True, "free_memory": True},
                                            timeout=aiohttp.ClientTimeout(total=2)):
                    pass
                await asyncio.sleep(1.5)
            except Exception:
                pass
        args = [str(LLAMA), "-m", str(MODEL), "--host", "127.0.0.1", "--port", str(PORT), "-c", "32768", "-np", "1",
                "--jinja", "-fa", "on", "-ngl", "99" if gpu else "0"]
        if MMPROJ.is_file():
            args += ["--mmproj", str(MMPROJ)]
        if not gpu:
            args += ["-t", "16", "--no-mmproj-offload"]
        log = open(ROOT / "llm.log", "ab")
        self.proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.device = "GPU" if gpu else "CPU"
        for _ in range(240):
            if self.proc.poll() is not None:
                raise RuntimeError("改写模型启动失败（见 h3studio/llm.log）")
            try:
                async with self.http().get(f"http://127.0.0.1:{PORT}/health", timeout=aiohttp.ClientTimeout(total=2)) as r:
                    if r.status == 200:
                        return
            except Exception:
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError("改写模型启动超时")

    def stop(self):
        if self.running():
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
        self.proc = None

    async def reaper(self):
        while True:
            await asyncio.sleep(20)
            if self.running() and time.time() - self.last > IDLE_S and not self.lock.locked():
                self.stop()

    async def chat(self, system: str, content, max_tokens=2000, temperature=0.6) -> str:
        """Follow the console's route for this capability (text, or vision when there are pictures); fall back down the list."""
        from oneshot.providers import catalog as providers
        cap = "vision" if has_image(content) else "text"
        rts = providers.routes(cap) or ([{"provider": {"kind": "local_qwen", "name": "本地 Qwen"}, "model": None}] if self.local_ok() else [])
        if not rts:
            raise RuntimeError("没有可用的" + ("看图" if cap == "vision" else "文本") + "模型，请在控制台「模型与服务」里配置")
        errs = []
        for r in rts:
            pr = r["provider"]
            try:
                if pr["kind"] == "local_qwen":
                    if not self.local_ok():
                        raise RuntimeError("本地 Qwen 没装好")
                    return await self._local_chat(system, content, max_tokens, temperature)
                out = await providers.chat(self.http(), pr, r["model"], system, content, max_tokens, temperature)
                self.via = pr["name"]
                return out
            except Exception as e:
                errs.append(f"{pr.get('name')}：{e}")
        raise RuntimeError("；".join(errs))

    async def _local_chat(self, system: str, content, max_tokens=2000, temperature=0.6, *, force_cpu=False,
                          response_schema=None) -> str:
        async with self.lock:
            if force_cpu and self.running() and self.device == "GPU":
                await asyncio.to_thread(self.stop)
            await self.start(force_cpu=force_cpu)
            self.last = time.time()
            body = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
                    "max_tokens": max_tokens, "temperature": temperature, "top_p": 0.9,
                    "chat_template_kwargs": {"enable_thinking": False}}
            if response_schema is not None:
                body["response_format"] = {"type":"json_object", "schema":response_schema}
            async with self.http().post(f"http://127.0.0.1:{PORT}/v1/chat/completions", json=body,
                                        timeout=aiohttp.ClientTimeout(total=600)) as r:
                j = await r.json(content_type=None)
            self.last = time.time()
            if "choices" not in j:
                raise RuntimeError("改写失败：" + json.dumps(j, ensure_ascii=False)[:300])
            text = j["choices"][0]["message"]["content"] or ""
            self.via = self.device
            return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def _ref(comfy_dir: Path, ref: str) -> Path:
    from oneshot.generation.tools import ref_path          # tools imports this module; resolve lazily
    return ref_path(comfy_dir, ref)


def image_part(path: Path, max_side=896):
    from PIL import Image
    with Image.open(path) as image:
        return encode_image_part(image, max_side)


def encode_image_part(image, max_side=896):
    im = image.convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()}}


def strip_fences(t: str) -> str:
    t = t.strip()
    t = re.sub(r"^```[a-zA-Z]*\n", "", t)
    t = re.sub(r"\n```$", "", t)
    return t.strip()


BASE_RULES = """You rewrite a user's short video request (often in Chinese) into a MiniMax H3 prompt, following the guide below exactly.
Output ONLY the three fields, in this order and nothing else (no alignment line, no code fence, no commentary):
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
Rules: write in English; keep dialogue/lyrics in their original language inside <d>[Chinese] ...</d> (or the right language tag) with speaker IDs like (S1);
keep on-screen text verbatim in double quotes; give concrete visual detail for every shot (style, composition, subject appearance and position,
environment and lighting, actions in time order, camera motion with the guide's vocabulary, synchronized sounds); never write negative prompts;
inside a shot describe actions in order with words like 'then', 'as', 'a moment later' and NO timestamps (timestamps only start later shots: '[Shot 2] At 00:03.500, the camera cuts to ...'); cut times must be strictly increasing and within the duration; prefer a single continuous shot for clips of 8 seconds or less unless the user asks for cuts; aim for 200-400 words in integrated_multimodal_description.
Do not invent dialogue the user did not ask for, unless the user wrote a line of speech.

=== GUIDE ===
"""

REF_RULES = """You rewrite a user's short video request (often in Chinese) into a MiniMax H3 full-reference (Ref2VA) prompt, following the guide below exactly.
Output ONLY the six sections, in this order, each starting with its name and a colon on its own line:
subject_definitions:, summary:, retention_analysis:, detailed_description:, overall_soundscape:, non_diegetic_music:
No code fence, no commentary. Use exactly the reference labels you are given (they are already bound to the attached images);
do not add or renumber labels. Character reference images define <Subject N> (cite the picture inside the subject definition, no standalone picture line);
frame images get standalone <Picture N> lines as first frame / keyframe / last frame at the given times.
Rules: write in English; dialogue in <d>[Chinese] ...</d> with (S1) speaker IDs, verbatim; describe the referenced subjects' visible features from the images;
detailed_description 300-450 words, one or two style sentences then [Shot 1] ...; later shots `[Shot N] At MM:SS.mmm, ...`; no timestamps inside a shot; prefer one continuous shot for clips of 8 seconds or less unless the user asks for cuts; no negative prompts.
Do not invent dialogue the user did not ask for, unless the user wrote a line of speech.

=== GUIDE ===
"""


def alignment_line(frames, end: float) -> str:
    """The official first/last-frame instruction for I2VA / FL2VA / L2VA (frames: list of times)."""
    if not frames:
        return ""
    if len(frames) == 1:
        if frames[0] <= 0.01:
            return "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."
        return f"How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the {end:.2f}-second mark of the target video."
    return ("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the "
            f"target video; Picture 2 (from Shot 1) aligns with the {end:.2f}-second mark of the target video.")


async def rewrite_video(llm: LLM, comfy_dir: Path, req: dict) -> dict:
    """req: prompt, sound, music, duration, images [{ref, name, caption, role(subject|frame), time, index}], planned(bool), end(float)."""
    imgs = req.get("images") or []
    end = float(req["end"])
    subj = [im for im in imgs if im.get("role") == "subject"]
    frames = sorted([im for im in imgs if im.get("role") != "subject"], key=lambda im: float(im.get("time", 0)))
    planned = bool(req.get("planned"))
    user_text = req["prompt"].strip()
    extra = ""
    if req.get("sound"): extra += f"\nSound the user wants: {req['sound']}"
    if req.get("music"): extra += f"\nBackground music the user wants: {req['music']}"
    content = []
    if planned:
        labels = []
        for k, im in enumerate(subj):
            labels.append((im, f"<Picture {k+1}> = character reference image for <Subject {k+1}>" + (f" ({im.get('name')})" if im.get("name") else "")
                           + (f", user note: {im['caption']}" if im.get("caption") else "")))
        for j, im in enumerate(frames):
            t = float(im["time"])
            kind = "first frame" if t <= 0.01 else ("last frame" if t >= end - 0.05 else "keyframe")
            labels.append((im, f"<Picture {len(subj)+j+1}> = {kind} of the target video at {t:.2f} seconds" + (f", user note: {im['caption']}" if im.get("caption") else "")))
        # map the canvas's @图k to labels
        pic = {}
        for k, im in enumerate(subj): pic[im["index"]] = f"<Picture {k+1}>" + (f" / <Subject {k+1}>")
        for j, im in enumerate(frames): pic[im["index"]] = f"<Picture {len(subj)+j+1}>"
        user_text = re.sub(r"@图(\d+)", lambda m: pic.get(int(m.group(1)), m.group(0)), user_text)
        task = (f"Task: Ref2VA, target video duration {end:.2f} seconds (24 fps). Task type prefix for summary: "
                + ("[keyframe completion + reference generation]" if frames and subj else "[keyframe completion]" if frames else "[reference generation]")
                + ".\nReference labels (images attached in this order):\n" + "\n".join(l for _, l in labels)
                + f"\n\nUser request (rewrite this):\n{user_text}{extra}")
        content.append({"type": "text", "text": task})
        for im, l in labels:
            content.append({"type": "text", "text": l})
            content.append(image_part(_ref(comfy_dir, im["ref"])))
        system = REF_RULES + (ROOT / "guides/ref_en.md").read_text() + "\n\n=== BASE FORMAT GUIDE (shots, camera, dialogue) ===\n" + (ROOT / "guides/base_en.md").read_text()
        out = strip_fences(await llm.chat(system, content, max_tokens=2600))
        if "subject_definitions:" not in out or "detailed_description:" not in out:
            raise RuntimeError("改写结果格式不对，请重试")
        out = out[out.index("subject_definitions:"):]
        return {"prompt": out, "mode": "Ref2VA", "device": llm.via}
    times = [float(im.get("time", 0)) for im in frames]
    if len(frames) == 2:
        times = [0.0, end]
    mode = "T2VA" if not frames else ("FL2VA" if len(frames) == 2 else ("I2VA" if times[0] <= 0.01 else "L2VA"))
    user_text = re.sub(r"@图(\d+)", lambda m: "the subject in Picture 1" if m.group(1) == "1" else f"Picture {m.group(1)}", user_text)
    task = f"Task: {mode}, target video duration {end:.2f} seconds (24 fps)."
    if mode == "I2VA": task += " Picture 1 (attached) is the first frame at 0.00 s: start from it and develop forward."
    if mode == "FL2VA": task += f" Picture 1 is the first frame (0.00 s) and Picture 2 the last frame ({end:.2f} s): describe the continuous path between them, single shot unless the user asks for cuts; the final shot must land on Picture 2."
    if mode == "L2VA": task += f" Picture 1 (attached) is the last frame at {end:.2f} s: infer a plausible earlier state and converge onto it."
    content.append({"type": "text", "text": task + f"\n\nUser request (rewrite this):\n{user_text}{extra}"})
    for j, im in enumerate(frames):
        content.append({"type": "text", "text": f"Picture {j+1}" + (f" (user note: {im['caption']})" if im.get("caption") else "")})
        content.append(image_part(_ref(comfy_dir, im["ref"])))
    out = strip_fences(await llm.chat(BASE_RULES + (ROOT / "guides/base_en.md").read_text(), content, max_tokens=1800))
    if "integrated_multimodal_description:" not in out:
        raise RuntimeError("改写结果格式不对，请重试")
    out = out[out.index("integrated_multimodal_description:"):]
    return {"prompt": out, "mode": mode, "device": llm.via}


async def expand_image(llm: LLM, comfy_dir: Path, template: dict, ids: dict, prompt: str, images, ar_text: str) -> str:
    """H3-Image's official prompt expansion (the template's own system/task prompts), on the fast local LLM."""
    system = template[ids["sys"]]["inputs"]["value"]
    task = template[ids["task"]]["inputs"]["value"].replace("{input text}", prompt)
    content = []
    for i, im in enumerate(images):
        content.append({"type": "text", "text": f"Reference Media: <Picture {i+1}>"})
        content.append(image_part(_ref(comfy_dir, im["ref"])))
    content.append({"type": "text", "text": task + f"\n\nUser Aspect Ratio Selection: {ar_text}"})
    out = strip_fences(await llm.chat(system, content, max_tokens=1500))
    m = re.search(r"\{.*\}", out, re.S)
    if m:
        try:
            cap = json.loads(m.group(0)).get("expanded_caption")
            if cap:
                return cap
        except ValueError:
            pass
    m = re.search(r'"expanded_caption"\s*:\s*"((?:[^"\\]|\\.)*)"', out, re.S)
    if m:
        return json.loads('"' + m.group(1) + '"')
    raise RuntimeError("扩写结果格式不对")
