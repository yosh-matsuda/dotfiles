#!/usr/bin/env python3
"""Print the account's AI credits used this billing cycle for the herdr tab bar.

The count comes from GitHub's internal /copilot_internal/user API, the source VS Code
and copilot-powerline use, so it covers every Copilot surface and machine. The token
is the one Copilot CLI uses: COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN, else the
plaintext copy in ~/.copilot/config.json that the CLI keeps when no keyring exists.
"""

import datetime
import json
import os
import urllib.request


def token():
    for name in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        if os.environ.get(name):
            return os.environ[name]
    path = os.path.join(os.environ.get("COPILOT_HOME") or os.path.expanduser("~/.copilot"), "config.json")
    with open(path, encoding="utf-8") as handle:
        # The file starts with // comments, which json does not accept.
        config = json.loads("".join(line for line in handle if not line.lstrip().startswith("//")))
    tokens = config.get("copilotTokens") or {}
    return next(value for value in tokens.values() if isinstance(value, str) and value)


def credits_used(snapshot):
    # Without a per-user budget, credits_used is the cycle total; with one, the used
    # part of the budget is entitlement - quota_remaining, as VS Code computes it.
    if snapshot["unlimited"]:
        return snapshot["credits_used"]
    return max(snapshot["entitlement"] - snapshot["quota_remaining"], 0)


try:
    request = urllib.request.Request(
        "https://api.github.com/copilot_internal/user",
        headers={"Authorization": f"token {token()}", "Accept": "application/json", "User-Agent": "dotfiles-herdr"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        used = credits_used(json.load(response)["quota_snapshots"]["premium_interactions"])
except Exception:
    raise SystemExit(1)

month = datetime.datetime.now(datetime.timezone.utc).strftime("%b")
print(f"{month} {used:,.0f} AIC")
