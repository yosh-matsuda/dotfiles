#!/bin/sh
# Herdr tracks one agent state per pane and infers it from the visible screen, so
# sessions running behind the current one in the same Copilot process never notify.
# This hook runs per session and pushes its own toast through the herdr socket API.

set -eu

[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

hook_input_file="$(mktemp "${TMPDIR:-/tmp}/copilot-session-notify.XXXXXX")" || exit 0
trap 'rm -f "$hook_input_file"' EXIT HUP INT TERM
cat >"$hook_input_file" 2>/dev/null || true

HERDR_HOOK_INPUT_FILE="$hook_input_file" python3 - <<'PY'
import json
import datetime
import json
import os
import socket
import time

TRANSCRIPT_TAIL_BYTES = 256 * 1024
BODY_LIMIT = 240
FRESH_WINDOW_SECONDS = 5.0
RETRY_ATTEMPTS = 8
RETRY_INTERVAL = 0.25

socket_path = os.environ.get("HERDR_SOCKET_PATH")
hook_input_file = os.environ.get("HERDR_HOOK_INPUT_FILE")
if not socket_path:
    raise SystemExit(0)

hook_input = {}
if hook_input_file:
    try:
        with open(hook_input_file, encoding="utf-8") as handle:
            content = handle.read()
        if content.strip():
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                hook_input = parsed
    except Exception:
        hook_input = {}


def first_text(*keys):
    for key in keys:
        value = hook_input.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())
    return None


def to_epoch(value):
    if isinstance(value, (int, float)):
        return value / 1000.0
    if isinstance(value, str):
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


# The Stop payload carries no message, so the turn's last reply is used as the body.
def last_assistant_message(path):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            start = max(0, handle.tell() - TRANSCRIPT_TAIL_BYTES)
            handle.seek(start)
            chunk = handle.read()
    except Exception:
        return None, None
    lines = chunk.split(b"\n")
    if start:
        lines = lines[1:]
    for line in reversed(lines):
        if b"assistant.message" not in line:
            continue
        try:
            event = json.loads(line.decode("utf-8"))
        except Exception:
            continue
        if event.get("type") != "assistant.message":
            continue
        text = event.get("data", {}).get("content")
        if isinstance(text, str) and text.strip():
            return " ".join(text.split()), to_epoch(event.get("timestamp"))
    return None, None


body = first_text("message", "notification_message", "notificationMessage")
transcript = first_text("transcript_path", "transcriptPath")

# A subagent also raises Stop, but reports its parent's transcript under its own
# session id. Staying silent there keeps the toast tied to the user's turn.
if transcript:
    session_id = first_text("session_id", "sessionId")
    owner = os.path.basename(os.path.dirname(os.path.normpath(transcript)))
    if session_id and owner and session_id != owner:
        raise SystemExit(0)

if not body and transcript:
    # The reply is still being flushed when the hook starts, and the half written
    # line parses as the previous turn, which reads like a mid-turn toast.
    stop_time = to_epoch(hook_input.get("timestamp"))
    for attempt in range(RETRY_ATTEMPTS):
        body, body_time = last_assistant_message(transcript)
        fresh = stop_time is None or body_time is None or body_time >= stop_time - FRESH_WINDOW_SECONDS
        if body and fresh:
            break
        if attempt + 1 < RETRY_ATTEMPTS:
            time.sleep(RETRY_INTERVAL)
if not body:
    body = first_text("notification_type", "notificationType", "stop_reason", "stopReason")
if not body:
    raise SystemExit(0)

cwd = first_text("cwd", "workspace_dir", "workspaceDir") or os.getcwd()
title = os.path.basename(os.path.normpath(cwd)) or "copilot"

request = {
    "id": f"copilot:session-notify:{time.time_ns()}",
    "method": "notification.show",
    # Sound is left to herdr's own state notifications and the OS toast itself.
    "params": {"title": title, "body": body[:BODY_LIMIT], "sound": "none"},
}

try:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(0.5)
    client.connect(socket_path)
    client.sendall((json.dumps(request) + "\n").encode("utf-8"))
    try:
        client.recv(4096)
    except Exception:
        pass
    client.close()
except Exception:
    pass
PY
