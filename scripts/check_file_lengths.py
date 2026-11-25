#!/usr/bin/env python3
"""Check the handwritten source and test files tracked by Git."""

from pathlib import Path
import subprocess


SOURCE_TYPES = {".py", ".js", ".cjs", ".mjs", ".html", ".css", ".sh"}
MAX_LINES = 500


def main():
    root = Path(__file__).resolve().parents[1]
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
    failures = []
    checked = 0
    for entry in tracked.split(b"\0"):
        if not entry:
            continue
        relative = Path(entry.decode())
        if relative.suffix not in SOURCE_TYPES or relative.is_relative_to("static/vendor"):
            continue
        with (root / relative).open("rb") as source:
            lines = sum(1 for _ in source)
        checked += 1
        if lines > MAX_LINES:
            failures.append((relative, lines))
    for path, lines in failures:
        print(f"{path}: {lines} lines (limit {MAX_LINES})")
    print(f"Checked {checked} handwritten files. {len(failures)} exceed {MAX_LINES} lines.")
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
