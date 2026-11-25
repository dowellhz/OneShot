"""Cut a grid image into individual panels."""
from pathlib import Path

from oneshot.generation.media_files import _new, ref_path


def grid_boxes(width: int, height: int, rows: int, cols: int):
    tw, th = width / cols, height / rows
    inset = round(min(tw, th) * 0.012)
    return [(round(c * tw) + inset, round(r * th) + inset, round((c + 1) * tw) - inset, round((r + 1) * th) - inset)
            for r in range(rows) for c in range(cols)]


def split_grid(comfy_dir: Path, ref: str, rows: int, cols: int) -> list:
    from PIL import Image
    with Image.open(ref_path(comfy_dir, ref)) as source:
        im = source.convert("RGB")
    out = []
    for index, box in enumerate(grid_boxes(*im.size, rows, cols)):
        r, c = divmod(index, cols)
        tile = im.crop(box)
        p, rf = _new(comfy_dir, "input", f"tile{r + 1}{c + 1}", ".png")
        tile.save(p)
        out.append({"ref": rf, "w": tile.width, "h": tile.height, "row": r, "col": c})
    return out
