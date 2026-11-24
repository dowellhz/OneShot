#!/usr/bin/env python3
"""Exercise video remake on an already running OneShot with real configured models."""

import argparse
import asyncio
import getpass
import json
import sys
import time
import uuid
from pathlib import Path

import aiohttp
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneshot.editing.render import FPS, SR, original_pcm, probe


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


async def request(http, method, path, **kwargs):
    async with http.request(method, path, allow_redirects=False, **kwargs) as response:
        if response.status != 200:
            raise RuntimeError(f"{method} {path}: HTTP {response.status} · {(await response.text())[:300]}")
        return await response.json()


async def upload(http, path):
    form = aiohttp.FormData()
    with path.open("rb") as file:
        form.add_field("file", file, filename=path.name)
        return await request(http, "POST", "/api/upload", data=form)


async def download(http, ref, destination):
    async with http.get("/media", params={"ref": ref}, allow_redirects=False) as response:
        require(response.status == 200, f"无法下载 {destination.name} · HTTP {response.status}")
        with destination.open("xb") as target:
            async for chunk in response.content.iter_chunked(1024 * 1024):
                target.write(chunk)


def verify_export(source, output):
    w, h, source_seconds, source_audio = probe(source)
    out_w, out_h, seconds, out_audio = probe(output)
    require(source_audio and out_audio, "原片和成片都必须包含音轨")
    require((out_w, out_h) == (w - w % 2, h - h % 2), "成片尺寸与原片显示方向不符")
    require(abs(seconds - source_seconds) <= 1 / FPS + .001, "成片时长与原片不符")
    samples = round(seconds * SR)
    original = original_pcm(source, samples).astype(np.float64)
    exported = original_pcm(output, samples).astype(np.float64)
    original_power = np.linalg.norm(original)
    require(original_power > 1 and np.linalg.norm(exported) > 1, "请使用包含清晰、非静音原声的原片")
    similarity = float(np.vdot(original, exported) / (original_power * np.linalg.norm(exported)))
    require(similarity >= .90, f"原声音轨或时间轴不匹配（相关系数 {similarity:.3f}）")
    return {"width": out_w, "height": out_h, "source_seconds": source_seconds, "seconds": seconds,
            "audio_correlation": round(similarity, 4)}


async def smoke(http, args):
    board = "remake-smoke-" + uuid.uuid4().hex[:12]
    started = time.monotonic()
    source = await upload(http, args.source)
    reference = await upload(http, args.reference)
    await request(http, "PUT", f"/api/board/{board}", json={
        "name": "视频重制验收 " + board[-6:], "shared": False,
        "nodes": [{"id": "n1", "name": "验收原片", "type": "video", "cur": 0, "versions": [source]}],
        "edges": [], "seq": 1,
    })
    print(f"验收画布 {board}", flush=True)
    asset = await request(http, "POST", "/api/memory", json={
        "name": "验收角色 " + board[-6:], "kind": "character", "board": board, "ref": reference["ref"],
    })
    route = f"/api/video-remake/{board}/n1"
    query = {"source": source["ref"]}
    index = args.shot - 1
    cut_revision = 0

    async def act(action, **fields):
        return await request(http, "POST", route, params=query, json={
            "action": action, "shot": index, "cut_revision": cut_revision, **fields,
        })

    async def wait(label, job_id, records):
        print(f"{label} {job_id}", flush=True)
        async with asyncio.timeout(args.timeout):
            while True:
                await request(http, "GET", "/api/jobs", params={"ids": job_id})
                current = await request(http, "GET", route, params=query)
                result = next((entry for entry in records(current) if entry["job"] == job_id), None)
                require(result is not None, f"{label}任务已从重制会话中移除")
                if result["state"] == "error":
                    raise RuntimeError(f"{label}失败 · {result.get('error', '任务未完成')}")
                if result["state"] == "done":
                    require(result.get("ref"), f"{label}完成后缺少媒体文件")
                    return result
                await asyncio.sleep(2)

    analyzed = await act("analyze")
    cut_revision = analyzed.get("cut_revision", 0)
    require(not analyzed.get("warning"), analyzed.get("warning"))
    require(index < len(analyzed["shots"]), "原片分析结果中没有指定镜头")
    shot = analyzed["shots"][index]
    require(0 < shot["end"] - shot["start"] <= 14, "请选择 14 秒以内的镜头")
    people = shot["summary"].get("characters") or []
    require(bool(people) or bool(args.person), "镜头未识别到人物，请使用 --person 指定原片人物")
    await act("map_person", person=args.person or people[0], asset=asset["id"], shots=[index])
    await act("select", frame="first", rect=args.rect)

    def preview_records(state):
        return state["shots"][index]["frames"]["first"]["previews"]

    def video_records(state):
        return state["shots"][index]["videos"]

    preview_job = preview_records(await act("preview", frame="first", asset=asset["id"], view="main"))[-1]["job"]
    preview = await wait("换角首帧", preview_job, preview_records)
    require(preview["asset"]["id"] == asset["id"] and preview["asset"]["ref"] == reference["ref"],
            "首帧没有关联本次验收角色参考图")
    await act("approve", frame="first", job=preview_job)
    video_job = video_records(await act("generate_video", motion=args.motion))[-1]["job"]
    video = await wait("镜头生成", video_job, video_records)
    require(video["first_frame"] == preview["ref"], "视频没有使用已采用的换角首帧")
    local_job = video_records(await act("localize", job=video_job))[-1]["job"]
    local = await wait("局部合成", local_job, video_records)
    require(local["derived_from"] == video_job, "局部合成没有关联生成视频")
    approved = await act("approve_video", job=local_job)
    require(approved["shots"][index]["adopted_video"] == local_job, "镜头审核结果未保存")
    export_job = (await act("export"))["export"]["job"]
    exported = await wait("成片合成", export_job, lambda state: [state["export"]])
    require(any(clip["ref"] == local["ref"] for clip in exported["clips"]), "成片没有使用审核采用的镜头")

    await download(http, preview["ref"], args.output / "preview.png")
    await download(http, local["ref"], args.output / "localized.mp4")
    await download(http, exported["ref"], args.output / "export.mp4")
    media = verify_export(args.source, args.output / "export.mp4")
    report = {"board": board, "asset": asset["id"], "shot": args.shot, "clip_range": [shot["start"], shot["end"]],
              "jobs": {"preview": preview_job, "video": video_job, "local": local_job, "export": export_job},
              "export": media, "elapsed_seconds": round(time.monotonic() - started, 1)}
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


async def main(args):
    _, _, seconds, has_audio = probe(args.source)
    require(0 < seconds <= 60 and has_audio, "验收原片须在 60 秒内且包含原声")
    args.output.mkdir(parents=True, exist_ok=False)
    password = getpass.getpass("验收账号密码：")
    async with aiohttp.ClientSession(base_url=args.url.rstrip("/"), cookie_jar=aiohttp.CookieJar(unsafe=True),
                                     timeout=aiohttp.ClientTimeout(total=180, connect=10)) as http:
        await request(http, "POST", "/api/auth/login", json={"username": args.username, "password": password})
        await smoke(http, args)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="已运行的 OneShot 服务地址")
    parser.add_argument("--username", required=True, help="用于创建私有验收画布的账号")
    parser.add_argument("--source", type=Path, required=True, help="带原声的视频")
    parser.add_argument("--reference", type=Path, required=True, help="用于替换的角色参考图")
    parser.add_argument("--output", type=Path, required=True, help="尚不存在的验收结果目录")
    parser.add_argument("--shot", type=int, default=1, help="镜头编号，从 1 开始")
    parser.add_argument("--person", help="原片人物名称，可覆盖视觉模型识别结果")
    parser.add_argument("--rect", nargs=4, type=float, required=True, metavar=("X0", "Y0", "X1", "Y1"),
                        help="指定镜头首帧的人物框，坐标范围 0–1")
    parser.add_argument("--motion", default="", help="补充镜头动作说明")
    parser.add_argument("--timeout", type=int, default=1200, help="每个生成或渲染任务的等待秒数")
    args = parser.parse_args()
    x0, y0, x1, y1 = args.rect
    if args.shot < 1 or args.timeout < 1 or not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        parser.error("请检查镜头编号、等待时间和人物框坐标")
    try:
        asyncio.run(main(args))
    except (RuntimeError, OSError, asyncio.TimeoutError, aiohttp.ClientError) as error:
        parser.exit(1, f"验收未通过 · {error or '任务等待超时'}\n")
