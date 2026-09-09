#!/usr/bin/env python3
"""Compare the live Copilot CLI settings with the ones tracked in dotfiles.

The playbook merges files/copilot/settings.json into ~/.copilot/settings.json,
so the flow is one way. Settings changed through the CLI stay local unless they
are copied back by hand. This reports what differs, using the same recursive
merge semantics as the playbook.
"""

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TRACKED = REPO_ROOT / "files" / "copilot" / "settings.json"


def live_path() -> Path:
    home = os.environ.get("COPILOT_HOME")
    return Path(home) / "settings.json" if home else Path.home() / ".copilot" / "settings.json"


def load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"{path}: invalid JSON: {exc}")
    if not isinstance(data, dict):
        sys.exit(f"{path}: expected a JSON object")
    return data


def walk(live, tracked, prefix=""):
    """Yield (kind, dotted_key, live_value, tracked_value) for every leaf."""
    for key in sorted(set(live) | set(tracked)):
        path = f"{prefix}.{key}" if prefix else key
        in_live, in_tracked = key in live, key in tracked
        live_value = live.get(key)
        tracked_value = tracked.get(key)

        if isinstance(live_value, dict) and isinstance(tracked_value, dict):
            yield from walk(live_value, tracked_value, path)
        elif not in_tracked:
            yield "untracked", path, live_value, None
        elif not in_live:
            yield "missing", path, None, tracked_value
        elif live_value != tracked_value:
            yield "drift", path, live_value, tracked_value


def fmt(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit machine-readable output")
    args = parser.parse_args()

    live_file = live_path()
    findings = list(walk(load(live_file), load(TRACKED)))

    if args.json:
        print(json.dumps([
            {"kind": kind, "key": key, "live": live, "tracked": tracked}
            for kind, key, live, tracked in findings
        ], ensure_ascii=False, indent=2))
        return 0

    print(f"live:    {live_file}")
    print(f"tracked: {TRACKED}")

    groups = {
        "untracked": ("Local only, kept by the merge; copy into the tracked file to keep everywhere", []),
        "drift": ("Tracked value differs; the next playbook run restores the tracked value", []),
        "missing": ("Tracked but absent locally; the next playbook run adds it", []),
    }
    for kind, key, live, tracked in findings:
        groups[kind][1].append((key, live, tracked))

    for kind, (title, rows) in groups.items():
        if not rows:
            continue
        print(f"\n{kind} — {title}")
        for key, live, tracked in rows:
            if kind == "drift":
                print(f"  {key}\n    live:    {fmt(live)}\n    tracked: {fmt(tracked)}")
            elif kind == "untracked":
                print(f"  {key} = {fmt(live)}")
            else:
                print(f"  {key} = {fmt(tracked)}")

    if not findings:
        print("\nin sync")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
