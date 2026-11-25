"""Generate and queue character previews against fixed frames."""
from __future__ import annotations

import asyncio

from oneshot.editing import image_editor
from oneshot.editing.remake_reference_assets import role_reference
from oneshot.editing.remake_regions import person_selection, preview_mask
from oneshot.editing.remake_state import (
    MAX_PREVIEWS,
    pending,
    submitted_job,
)
from oneshot.memory.creative_memory import character_notes
from oneshot.memory.creative_memory import fail


async def generate_preview(req, host, key, frame, data, mapping=None, *, role=None):
    selection = person_selection(frame, mapping)
    if not selection:
        fail("请先在原片画面中选中待替换的人物")
    if pending(frame["previews"]):
        fail("此画面已有生成任务，请等待完成", 409)
    if len(frame["previews"]) >= MAX_PREVIEWS:
        fail("此画面已达到预览版本上限")
    asset, view, reference = role or role_reference(req, key[1], data)
    if mapping and asset["id"] != mapping["asset"]:
        fail("替换角色已更新，请刷新并确认人物映射", 409)
    if not host.tools.ref_path(host.COMFY_DIR, reference).is_file():
        fail("角色参考图文件找不到")
    note = data.get("note", "")
    if not isinstance(note, str):
        fail("修改要求格式不正确")
    # Keep asset text as context and avoid resolving extra mentions from its descriptions.
    context = "。".join(x for x in (asset["name"], note[:800], character_notes(asset),
                                  asset.get("constraints"), asset.get("desc")) if x)[:6200]
    prompt = (
        "把遮罩内原人物换成 @图3 的角色。保持原镜头里主体的位置、体型占位、姿势、朝向、光线和透视。"
        "保持同画面的其他人物、场景、道具及原有遮挡次序。保持参考角色的面部、服装与配饰左右位置。"
        + context.replace("@", "＠")
    )
    try:
        protection = frame.get("protection", {}).get("mask")
        mask = selection["mask"]
        if protection:
            mask = await asyncio.to_thread(preview_mask, host.COMFY_DIR, mask, protection)
        payload = await asyncio.to_thread(image_editor.prepare, host.COMFY_DIR, {
            "ref": frame["ref"], "mask": mask, "mode": "region", "backend": "h3",
            "board": key[1], "prompt": prompt, "label": f"角色替换预览 · {asset['name']}",
        })
    except (ValueError, OSError) as error:
        fail(str(error))
    payload["images"].append({"ref": reference})
    preview = submitted_job(await host.generate_request(req, payload))
    preview.update({
        "mask": selection["mask"],
        "protection": protection,
        "note": note[:800],
        "source_person": mapping["source"] if mapping else None,
        "asset": {"id": asset["id"], "name": asset["name"], "view": view, "ref": reference},
    })
    frame["previews"].append(preview)
    return {"asset": asset["id"], "view": view}
