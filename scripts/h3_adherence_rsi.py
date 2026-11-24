"""Run paired, failure-driven H3 video evaluations without changing live settings."""

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
from random import SystemRandom
import time
from urllib.request import Request, urlopen

import av
import cv2
import numpy as np


RED, RIGHT, MIDDLE = 0.23, 0.77, 0.50
FPS, FRAMES = 24, 124
CATALOG = {
    "objects": "两盘始终各出现一次且不交叉",
    "fixed": "红盘保持原位",
    "start": "蓝盘在 0.5 秒前保持原位，并在 1.5 秒前明显左移",
    "hold": "蓝盘在 2.0–2.7 秒居中停留",
    "return": "蓝盘在 4.65 秒后回到右侧起点",
    "monotone": "往返途中没有折返或重复动作",
}
BASE = (
    "A single fixed overhead shot. Keep exactly one red disk fixed on the left and one blue disk throughout. "
    "The blue disk holds at its right-hand starting position until 0.6 seconds, slides left once horizontally "
    "to the middle by 2.0 seconds, holds there until 2.7 seconds, then slides right once to its exact starting "
    "position by 4.65 seconds and stays there to the end. The two disks never cross. The camera stays fixed."
)
TIMED = (
    "A single fixed overhead shot. Keep exactly one red disk fixed on the left and one blue disk throughout.\n"
    "0.0–0.6 s: the blue disk stays at its right-hand starting position.\n"
    "0.6–2.0 s: the blue disk slides left once, horizontally, to the middle.\n"
    "2.0–2.7 s: the blue disk stays still in the middle.\n"
    "2.7–4.65 s: the blue disk slides right once to exactly its starting point. Hold there to the end.\n"
    "The two disks never cross. The camera stays fixed."
)


def disk_centers(rgb):
    red, green, blue = np.moveaxis(np.asarray(rgb).astype(np.int16), -1, 0)
    masks = ((red > 110) & (red > green + 58) & (red > blue + 50),
             (blue > 110) & (blue > red + 58) & (blue > green + 48))
    detections = []
    for mask in masks:
        count, _, areas, centers = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
        detections.append([float(centers[i, 0]) / mask.shape[1] for i in range(1, count)
                           if areas[i, cv2.CC_STAT_AREA] >= mask.size * .004])
    return detections


def measurements(path):
    rows = []
    with av.open(str(path)) as movie:
        stream = movie.streams.video[0]
        offset = None
        for index, frame in enumerate(movie.decode(stream)):
            timestamp = float(frame.time) if frame.time is not None else index / FPS
            if offset is None:
                offset = timestamp
            if index % 3 == 0:
                rows.append((round(timestamp - offset, 6), *disk_centers(frame.to_ndarray(format="rgb24"))))
    if not rows or rows[-1][0] < 4.85:
        raise ValueError(f"{path} has less than 4.85 seconds of sampled video")
    return rows


def score(rows):
    visible = [(t, r[0], b[0]) for t, r, b in rows if len(r) == len(b) == 1]
    intact = bool(rows) and len(visible) == len(rows) and all(r + .04 < b for _, r, b in visible)

    def window(start, end):
        return [b for t, _, b in visible if start <= t <= end]

    def all_near(values, target, tolerance):
        return bool(values) and all(abs(value - target) <= tolerance for value in values)

    hold = window(2, 2.7)
    left = window(.6, 2)
    right = window(2.7, 4.65)
    backtracking = sum(max(0, b - a - .003) for a, b in zip(left, left[1:]))
    backtracking += sum(max(0, a - b - .003) for a, b in zip(right, right[1:]))
    checks = {
        "objects": intact,
        "fixed": intact and max(abs(r - RED) for _, r, _ in visible) <= .04,
        "start": intact and all_near(window(0, .5), RIGHT, .025)
                 and any(b < RIGHT - .08 for b in window(1.25, 1.5)),
        "hold": intact and bool(hold) and sum(abs(b - MIDDLE) <= .055 for b in hold) >= .75 * len(hold),
        "return": intact and all_near(window(4.65, 4.99), RIGHT, .04),
        "monotone": intact and bool(left and right) and backtracking <= .06,
    }
    start = window(0, .5)
    return {"checks": checks, "score": sum(checks.values()),
            "early_blue_drift": round(max(abs(b - RIGHT) for b in start), 4) if start else None,
            "blue_backtracking": round(backtracking, 4), "samples": rows}


@dataclass(frozen=True)
class Strategy:
    timed: bool = False
    anchors: bool = False

    @property
    def name(self):
        return "-".join(part for part, enabled in (("timed", self.timed), ("anchors", self.anchors))
                        if enabled) or "baseline"


def next_strategy(current, failures, attempted):
    candidates = []
    if failures.intersection({"start", "hold", "return", "monotone"}) and not current.timed:
        candidates.append(Strategy(True, current.anchors))
    if failures and not current.anchors:
        candidates.append(Strategy(current.timed, True))
    return next((candidate for candidate in candidates if candidate not in attempted), None)


def compare(incumbent, challenger):
    regressions, gains = [], []
    for seed, original in incumbent.items():
        for name, passed in original["checks"].items():
            alternative = challenger[seed]["checks"][name]
            if passed != alternative:
                (gains if alternative else regressions).append({"seed": seed, "check": name})
    return {"gains": gains, "regressions": regressions, "pass": bool(gains) and not regressions}


def improve(render, dev_seeds, holdout_rounds, persist):
    all_seeds = [*dev_seeds, *(s for group in holdout_rounds if group is not None for s in group)]
    if len(set(all_seeds)) != len(all_seeds) or not dev_seeds or [] in holdout_rounds:
        raise ValueError("development and per-round holdout seeds must be disjoint")
    incumbent = Strategy()
    attempted = {incumbent}
    report = {"requirements": CATALOG, "development_seeds": dev_seeds,
              "reserved_holdout_seeds": holdout_rounds, "policy": "at least one gain and no regressions per split",
              "rounds": [], "recommended": None, "results": {}}
    persist(report)

    def assess(strategy, seeds):
        by_seed = report["results"].setdefault(strategy.name, {})
        for seed in seeds:
            if seed not in by_seed:
                path = render(strategy, seed)
                if path is None:
                    return None
                by_seed[seed] = {"video": str(path), **score(measurements(path))}
                persist(report)
        return {seed: by_seed[seed] for seed in seeds}

    for holdout in holdout_rounds:
        baseline = assess(incumbent, dev_seeds)
        if baseline is None:
            raise ValueError("missing incumbent development evidence")
        failures = {name for item in baseline.values() for name, passed in item["checks"].items() if not passed}
        candidate = next_strategy(incumbent, failures, attempted)
        if candidate is None:
            break
        attempted.add(candidate)
        row = {"incumbent": incumbent.name, "candidate": candidate.name, "triggered_by": sorted(failures)}
        report["rounds"].append(row)
        persist(report)
        trial = assess(candidate, dev_seeds)
        if trial is None:
            row["decision"] = "missing development videos"
        else:
            row["development"] = compare(baseline, trial)
            if not row["development"]["pass"]:
                row["decision"] = "development rejected"
            elif holdout is None:
                row["decision"] = "exploratory gain; fresh holdout required"
            else:
                control, test = assess(incumbent, holdout), assess(candidate, holdout)
                if control is None or test is None:
                    row["decision"] = "missing holdout videos"
                else:
                    row["holdout"] = compare(control, test)
                    row["decision"] = "recommend" if row["holdout"]["pass"] else "holdout rejected"
                    if row["holdout"]["pass"]:
                        incumbent = candidate
                        report["recommended"] = incumbent.name
        persist(report)
    return report


def fixture(path, blue_x):
    image = np.empty((352, 640, 3), dtype=np.uint8)
    image[:] = (226, 231, 232)
    for x, bgr in ((RED, (34, 30, 205)), (blue_x, (209, 57, 30))):
        cv2.circle(image, (round(x * image.shape[1]), image.shape[0] // 2), 37, bgr, -1)
    if not cv2.imwrite(str(path), image):
        raise OSError(f"could not save reference frame {path}")


def live_renderer(folder, port):
    endpoint = f"http://127.0.0.1:{port}"
    for name, x in (("start", RIGHT), ("middle", MIDDLE), ("end", RIGHT)):
        fixture(folder / f"{name}.png", x)

    def call(path, data=None):
        request = Request(endpoint + path, None if data is None else json.dumps(data).encode(),
                          headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    def render(strategy, seed):
        prefix = folder / f"{strategy.name}-{seed}"
        output = prefix.with_suffix(".mp4").resolve()
        job_file = prefix.with_suffix(".job")
        done = prefix.with_suffix(".done")
        if done.is_file() and output.is_file():
            return output
        keyframes = [{"path": str(folder / "start.png"), "frame": 0}]
        if strategy.anchors:
            keyframes.extend({"path": str(folder / f"{name}.png"), "frame": frame}
                             for name, frame in (("start", 12), ("middle", 54), ("end", 112)))
        request = {"kind": "video", "prompt": TIMED if strategy.timed else BASE,
                   "out": str(output), "width": 640, "height": 352,
                   "frames": FRAMES, "steps": 4, "turbo": True, "seed": seed, "keyframes": keyframes}
        if job_file.is_file():
            job = job_file.read_text().strip()
        else:
            status = call("/status")
            if not status["ready"] or status.get("running") or status.get("queue"):
                raise RuntimeError("H3 is busy or unavailable. Resume this evaluation on an idle engine.")
            prefix.with_suffix(".request.json").write_text(json.dumps(request, indent=2))
            job = call("/jobs", request)["id"]
            job_file.write_text(job)
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            state = call(f"/jobs?ids={job}")[job]
            if state["state"] == "done":
                if not output.is_file():
                    raise RuntimeError(f"H3 job {job} finished without the expected video {output}")
                done.touch()
                return output
            if state["state"] == "error":
                raise RuntimeError(state.get("error") or f"H3 job {job} failed")
            time.sleep(3)
        raise TimeoutError(f"recheck the existing H3 job {job} before submitting again")

    return render


def history_renderer(folder):
    videos = {}
    for file in folder.glob("spatial-*-request.json"):
        seed = json.loads(file.read_text())["seed"]
        name = file.name.removesuffix("-request.json")
        variant = "timed" if name.endswith("-adapted") else "baseline"
        if (video := folder / f"{name}.mp4").is_file():
            videos[variant, seed] = video
    return lambda strategy, seed: videos.get((strategy.name, seed))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--history", type=Path, help="rescore the original spatial comparison videos")
    mode.add_argument("--live", action="store_true", help="run fresh paired H3 renders on the current host")
    parser.add_argument("--resume", action="store_true", help="continue a live run in its existing output directory")
    parser.add_argument("--port", type=int, default=8189)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    output = args.out.resolve()
    report = output / "report.json"
    if args.resume:
        if not args.live:
            parser.error("--resume requires --live")
        previous = json.loads(report.read_text())
        if previous["mode"] != "fresh renders":
            parser.error("--resume requires an existing live report")
        dev, holdouts = previous["development_seeds"], previous["reserved_holdout_seeds"]
    else:
        output.mkdir(parents=True, exist_ok=False)
    if args.history:
        dev, holdouts = [8117, 21417], [None, None]
    elif not args.resume:
        seeds = SystemRandom().sample(range(1, 2**31), 6)
        dev, holdouts = seeds[:2], [seeds[2:4], seeds[4:]]
    render = history_renderer(args.history.resolve()) if args.history else live_renderer(output, args.port)
    mode_name = "historical replay only" if args.history else "fresh renders"

    def persist(data):
        temporary = report.with_suffix(".tmp")
        temporary.write_text(json.dumps({"mode": mode_name, **data}, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(report)

    result = improve(render, dev, holdouts, persist)
    print(json.dumps({"report": str(report), "recommended": result["recommended"], "rounds": result["rounds"]},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
