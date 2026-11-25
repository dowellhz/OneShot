"""Render and store depth guides for pinned shots."""
from __future__ import annotations

from oneshot.editing import video_depth
from oneshot.editing.remake_state import (
    MAX_SHOT_SECONDS,
    pending,
    submitted_job,
)
from oneshot.memory.creative_memory import fail


def prepare_depth(req, host, key, session, shot):
    board = host.board_meta(host.board_path(key[1]))
    if not board or not host.can_edit(req["user"], board):
        fail("需要画布编辑权限才能生成深度参考", 403)
    if depth := shot.get("depth"):
        if depth["state"] != "error":
            return
    config = video_depth.configuration()
    if not config:
        fail("部署主机尚未安装 Small 视频深度模型", 503)
    fps = host.film.FPS
    start, end = round(shot["start"] * fps), round(shot["end"] * fps)
    if not 0 < end - start <= MAX_SHOT_SECONDS * fps:
        fail(f"单段深度参考最多 {MAX_SHOT_SECONDS} 秒，请先拆分长镜头")
    source = host.tools.ref_path(host.COMFY_DIR, key[3])
    if not source.is_file():
        fail("原片文件已丢失")
    if any(other.get("depth") and pending([other["depth"]]) for other in session["shots"]):
        fail("此原片已有深度任务，请等待完成或取消后再提交", 409)
    display = session.get("display_oriented", False)

    def encode(progress, cancelled):
        return video_depth.generate(host.COMFY_DIR, source, start / fps, end - start, display,
                                    progress, cancelled, config)

    depth = submitted_job(host.enqueue_render(req, encode, seconds=(end - start) / fps,
                                              label="视频重制 · 深度参考", board=key[1], depth=True))
    first = shot["frames"]["first"]
    w, h = video_depth.dimensions(first["w"], first["h"])
    shot["depth"] = {**depth, "start": start / fps, "end": end / fps, "w": w, "h": h}
