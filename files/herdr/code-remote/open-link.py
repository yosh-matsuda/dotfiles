#!/usr/bin/env python3
"""Open a file link that herdr hands to the plugin, or the pane's directory, with code-remote.sh."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

PLUGIN_ID = "code-remote"
CODE_REMOTE = Path(__file__).resolve().parent / "code-remote.sh"
HERDR = os.environ.get("HERDR_BIN_PATH", "herdr")
FRAGMENT_POSITION = re.compile(r"L(\d+)(?:C(\d+))?")
SUFFIX_POSITION = re.compile(r"^(.+?):(\d+(?::\d+)?)$")


def notify(title: str, body: str) -> None:
    subprocess.run([HERDR, "notification", "show", title, "--body", body], check=False, capture_output=True)


def split_link(url: str) -> tuple[str, str]:
    """Return the path and fragment of a link target."""
    if url.startswith("file:"):
        parts = urlsplit(url)
        return parts.path, parts.fragment
    path, _, fragment = url.partition("#")
    return path, fragment


def resolve(url: str, cwd: str) -> tuple[str, str] | None:
    """Return the existing path that a link points to, and its LINE[:COLUMN] if any."""
    path, fragment = split_link(url)
    position = ""
    if m := FRAGMENT_POSITION.match(fragment):
        position = m[1] + (f":{m[2]}" if m[2] else "")
    # marked percent-encodes Markdown link targets with encodeURI, so the decoded path comes first.
    for candidate in dict.fromkeys([unquote(path), path]):
        if not candidate:
            continue
        candidate = os.path.join(cwd, os.path.expanduser(candidate))
        if os.path.exists(candidate):
            return candidate, position
        if not position and (m := SUFFIX_POSITION.match(candidate)) and os.path.exists(m[1]):
            return m[1], m[2]
    return None


def main() -> int:
    context = json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON") or "{}")
    url = os.environ.get("HERDR_PLUGIN_CLICKED_URL") or context.get("clicked_url") or ""
    cwd = context.get("focused_pane_cwd") or os.path.expanduser("~")

    target, position = cwd, ""
    if url:
        resolved = resolve(url, cwd)
        if resolved is None:
            notify("Open in VS Code", f"No such file or directory: {unquote(url)}")
            return 1
        target, position = resolved

    args = ["--goto", "--", f"{target}:{position}"] if position else ["--", target]
    result = subprocess.run(
        ["bash", str(CODE_REMOTE), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        notify("Open in VS Code", result.stderr.strip() or f"code-remote exited with {result.returncode}")
        return result.returncode
    if link := result.stdout.strip():
        subprocess.run(
            [HERDR, "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "link", "--env", f"CODE_REMOTE_LINK={link}"],
            check=False,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
