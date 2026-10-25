#!/usr/bin/env python3
"""Track what a Copilot CLI session is doing from its events.jsonl.

  status SESSION_PATH SESSION_ID
      Print, separated by U+001F: running background agents, running background shells,
      the tools the main agent is running, the mode, and the compaction count.
      SESSION_PATH is the session directory or its events.jsonl.
      files/copilot/statusline.sh calls this on every refresh.
  hook
      Run as a Copilot `notification` hook. When background work finishes,
      report the new count to the herdr sidebar right away instead of waiting
      for the next status line refresh.

Only new bytes of the log are read on each call; the position and the derived
state are kept in $XDG_RUNTIME_DIR per session.
"""

import datetime
import json
import os
import re
import subprocess
import sys
import time

RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
COPILOT_HOME = os.environ.get("COPILOT_HOME") or os.path.expanduser("~/.copilot")
MARKERS = (b'"tool.execution_', b'"subagent.', b'"system.notification"', b'"session.')
AGENT_ID = re.compile(r"agent_id: ([0-9a-f-]{36})")
SHELL_STARTED = re.compile(r"^<command (?:started in background with shellId: (\S+?)>|with shellId: (\S+) is still running)")
SHELL_DONE = re.compile(r"^<shellId: (\S+) completed")


def safe(name):
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)


def empty_state():
    return {"offset": 0, "inode": 0, "agents": [], "call_agents": {}, "shells": [], "detached": [], "tools": {},
            "mode": "interactive", "compactions": 0, "last_notification": ""}


def load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return {**empty_state(), **json.load(handle)}
    except (OSError, ValueError):
        return empty_state()


def result_text(data):
    result = data.get("result")
    content = result.get("content") if isinstance(result, dict) else result
    return content if isinstance(content, str) else ""


def apply(state, event):
    kind = event.get("type")
    data = event.get("data") or {}
    agents, shells, tools = set(state["agents"]), set(state["shells"]), state["tools"]
    if kind in ("session.start", "session.resume", "session.shutdown"):
        # Work from an earlier process of a resumed session never reports its end.
        agents, shells = set(), set()
        tools.clear()
        state["call_agents"].clear()
        state["detached"].clear()
        state["mode"] = "interactive"
    elif kind == "session.mode_changed":
        state["mode"] = data.get("newMode") or state["mode"]
    elif kind == "session.compaction_complete":
        state["compactions"] += 1
    elif data.get("parentToolCallId"):
        pass  # A subagent's own tools.
    elif kind == "tool.execution_start":
        call_id, name, args = data.get("toolCallId"), data.get("toolName"), data.get("arguments") or {}
        if call_id and name:
            tools[call_id] = name
        if name == "bash" and args.get("detach"):
            state["detached"].append(call_id)  # Services, not work Copilot waits for.
        if name == "task" and args.get("mode") == "background":
            agents.add(call_id)
        elif name == "write_agent" and args.get("agent_id"):
            agents.add(args["agent_id"])
        elif name == "stop_bash" and args.get("shellId"):
            shells.discard(str(args["shellId"]))
    elif kind == "tool.execution_complete":
        call_id = data.get("toolCallId")
        name = tools.pop(call_id, None)
        text = result_text(data)
        found = AGENT_ID.search(text)
        if call_id in agents and found:
            agents.discard(call_id)
            agents.add(found.group(1))
            state["call_agents"][call_id] = found.group(1)
        started = SHELL_STARTED.match(text) if name == "bash" else None
        if call_id in state["detached"]:
            state["detached"].remove(call_id)
        elif started:
            shells.add(started.group(1) or started.group(2))
        done = SHELL_DONE.match(text)
        if done:
            shells.discard(done.group(1))
    elif kind in ("subagent.completed", "subagent.failed"):
        call_id = data.get("toolCallId")
        agents.discard(call_id)
        agents.discard(state["call_agents"].pop(call_id, None))
    elif kind == "system.notification":
        note = data.get("kind") or {}
        if note.get("type") in ("agent_completed", "agent_idle"):
            agents.discard(note.get("agentId"))
        elif note.get("type") in ("shell_completed", "shell_detached_completed"):
            shells.discard(str(note.get("shellId")))
        state["last_notification"] = event.get("timestamp") or state["last_notification"]
    state["agents"], state["shells"] = sorted(a for a in agents if a), sorted(shells)


def update(events_path, session_id):
    # The status line passes the session directory; hooks pass events.jsonl itself.
    if os.path.isdir(events_path):
        events_path = os.path.join(events_path, "events.jsonl")
    state_path = os.path.join(RUNTIME_DIR, f"copilot-activity-state-{safe(session_id)}.json")
    state = load(state_path)
    try:
        stat = os.stat(events_path)
    except OSError:
        return state
    if stat.st_ino != state["inode"] or stat.st_size < state["offset"]:
        state = empty_state()
        state["inode"] = stat.st_ino
    if stat.st_size > state["offset"]:
        try:
            with open(events_path, "rb") as handle:
                handle.seek(state["offset"])
                chunk = handle.read(stat.st_size - state["offset"])
        except OSError:
            return state
        end = chunk.rfind(b"\n") + 1  # A line still being written is read next time.
        for line in chunk[:end].split(b"\n"):
            if not any(marker in line for marker in MARKERS):
                continue
            try:
                apply(state, json.loads(line))
            except (ValueError, AttributeError):
                continue
        state["offset"] += end
        tmp = f"{state_path}.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
        os.replace(tmp, state_path)
    return state


def events_path_for(session_id):
    return os.path.join(COPILOT_HOME, "session-state", session_id, "events.jsonl")


def epoch(timestamp):
    try:
        return datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return 0.0


def background_label(state):
    count = len(state["agents"]) + len(state["shells"])
    return f"⧗{count}" if count else ""


def status(events_path, session_id):
    state = update(events_path, session_id)
    print("\x1f".join([str(len(state["agents"])), str(len(state["shells"])),
                       " ".join(state["tools"].values()), state["mode"], str(state["compactions"])]))


def hook():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    session_id = payload.get("sessionId") or payload.get("session_id")
    pane_id = os.environ.get("HERDR_PANE_ID")
    if os.environ.get("HERDR_ENV") != "1" or not pane_id or not session_id:
        return
    events_path = payload.get("transcriptPath") or payload.get("transcript_path") or events_path_for(session_id)
    # The hook can fire before the notification reaches the log; wait for it briefly.
    started = time.time()
    state = update(events_path, session_id)
    while time.time() - started < 3 and epoch(state["last_notification"]) < started - 5:
        time.sleep(0.25)
        state = update(events_path, session_id)
    subprocess.run([os.environ.get("HERDR_BIN_PATH") or "herdr", "pane", "report-metadata", pane_id,
                    "--source", "copilot-statusline", "--seq", str(time.time_ns()),
                    "--token", f"bg={background_label(state)}"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    # The status line skips reports that match its cache, which no longer matches herdr.
    try:
        os.remove(os.path.join(RUNTIME_DIR, f"herdr-aic-{safe(pane_id)}"))
    except OSError:
        pass


if __name__ == "__main__":
    if sys.argv[1:2] == ["status"] and len(sys.argv) == 4:
        status(sys.argv[2], sys.argv[3])
    elif sys.argv[1:2] == ["hook"]:
        hook()
    else:
        sys.exit(f"usage: {sys.argv[0]} status SESSION_PATH SESSION_ID | hook")
