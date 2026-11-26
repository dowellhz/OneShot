"""Check localized motion when the supplied keyframes isolate a small pose change."""

import asyncio

import aiohttp
from PIL import Image, ImageChops, ImageOps, ImageStat

from oneshot import config
from oneshot.editing import render_media
from oneshot.generation import rewriter, tools

_SYSTEM = """Inspect the real video frames in timestamp order and compare the targeted body part or object
at the beginning, middle and end. Describe the visible change in 3 to 12 words. Pass only if the frames clearly
show the required local motion relative to the main subject or setting. Use fail for a clear contradiction
and unclear if the expected movement is not visible enough to decide. Return only the JSON object."""
_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["observation", "status"],
    "properties": {
        "observation": {"type": "string", "minLength": 1, "maxLength": 96},
        "status": {"enum": ["pass", "fail", "unclear"]},
    },
}


def motion_region(references):
    width, height = references[0].size
    longest = max(width, height)
    size = (max(1, round(width * 160 / longest)), max(1, round(height * 160 / longest)))
    start, middle, end = [ImageOps.fit(image, size) for image in references]
    if start.tobytes() != end.tobytes():
        return None
    difference = ImageChops.difference(start, middle).convert("L")
    mask = difference.point(lambda value: 255 if value >= 30 else 0)
    bounds = mask.getbbox()
    if not bounds or mask.histogram()[255] < 12:
        return None
    left, top, right, bottom = bounds
    width, height = size
    if (right - left) * (bottom - top) > width * height * .12:
        return None
    region = (
        max(0, left / width - .1375),
        max(0, top / height - .145),
        min(1, right / width + .1375),
        min(1, bottom / height + .19),
    )
    return region, (start, middle, end), mask


def pose_distance(first, second, mask):
    delta = ImageChops.difference(first, second).convert("L")
    return ImageStat.Stat(delta, mask).mean[0]


def matches_anchor_poses(samples, references, mask):
    # Require both a close match to the expected pose and clear separation from the alternate pose.
    separation = pose_distance(references[0], references[1], mask)
    for (image, _), expected, other in zip(samples, references, (references[1], references[0], references[1])):
        normalized = ImageOps.fit(image, expected.size)
        distance = pose_distance(normalized, expected, mask)
        margin = pose_distance(normalized, other, mask) - distance
        if distance > separation * .6 or margin < separation * .25:
            return False
    return True


def review_content(clause, guides, path):
    opening, action, ending = [float(guide.get("time") or 0) for guide in guides]
    if not 0 <= opening < action < ending:
        return []
    references = []
    for guide in guides:
        with Image.open(tools.ref_path(config.COMFY_DIR, guide["ref"])) as image:
            references.append(image.convert("RGB"))
    focus = motion_region(references)
    if focus is None:
        return []
    region, poses, mask = focus
    approach = opening + (action - opening) * 2 / 3
    samples = [render_media.capture_frame(path, "time", target) for target in (opening, approach, action, ending)]
    if not matches_anchor_poses((samples[0], samples[2], samples[3]), poses, mask):
        return []
    content = [{"type": "text", "text": f"Required action: {clause}"}]
    for image, time in samples:
        width, height = image.size
        box = tuple(round(value * scale) for value, scale in zip(region, (width, height, width, height)))
        content.extend([
            {"type": "text", "text": f"Generated crop at {time:.2f}s"},
            rewriter.encode_image_part(image.crop(box), 416),
        ])
    return content


async def verify(llm, report, images, path):
    checks = report["checks"]
    clause = report.get("requirements", {}).get("action")
    other_checks_pass = all(value == "pass" for key, value in checks.items() if key != "action")
    if not clause or checks["action"] == "pass" or not other_checks_pass:
        return report
    guides = [image for image in images if image.get("role") == "frame"]
    if len(guides) != 3:
        return report
    try:
        guides.sort(key=lambda image: float(image.get("time") or 0))
        content = await asyncio.to_thread(review_content, clause, guides, path)
        if not content:
            return report
        raw = await llm.local_vision(_SYSTEM, content, max_tokens=170, temperature=0, response_schema=_SCHEMA)
        verdict = tools.parse_json(raw)
    except (aiohttp.ClientError, OSError, RuntimeError, ValueError):
        return report
    if not isinstance(verdict, dict) or verdict.get("status") != "pass":
        return report
    observation = verdict.get("observation")
    if not isinstance(observation, str) or not observation.strip():
        return report
    checks["action"] = "pass"
    report["score"] = 2 * len(checks)
    report["passed"] = True
    report["requirements"].pop("action")
    summary = observation.strip()[:96]
    full_frame_observation = report.get("action_observation")
    if full_frame_observation:
        report["evidence"] = report["evidence"].replace(full_frame_observation, summary, 1)
    else:
        report["evidence"] += " " + summary
    return report
