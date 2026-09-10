# dotfiles

Ansible-based dotfiles for my local development environment.

This repository applies shell settings, XDG config files, and CLI tools on Ubuntu, WSL, and macOS. It is meant to be re-run to keep the machine state consistent.

## What it sets up

-   dotfiles in the home directory
-   XDG config files
-   Homebrew packages
-   pipx packages
-   Docker on WSL
-   herdr and automatic startup in interactive SSH terminals
-   fish and fisher

## Requirements

-   Python 3
-   Ansible
-   sudo access
-   Git

Install the required Ansible collection before the first run:

```bash
$ ansible-galaxy collection install -r collections/requirements.yml
```

## Usage

Copy the local example files and edit them for your environment. Both are Git-ignored; put local inventory entries and private variables only there.

```bash
$ cp local.hosts.yml.example local.hosts.yml
$ cp local.vars.yml.example local.vars.yml
```

Then run the playbook:

```bash
$ ansible-playbook site.yml --ask-become-pass
```

On Ubuntu 26.04 with sudo-rs, prefix the command with `ANSIBLE_BECOME_EXE=sudo.ws`.

Main settings live under [files](files). Package lists and shared variables are defined in [group_vars/all.yml](group_vars/all.yml). Paths are preconfigured in `ansible.cfg`, so run the commands from the repository root.

Syntax check:

```bash
$ ansible-playbook site.yml --syntax-check
```

## Things to know

### herdr

-   herdr is installed with Homebrew. Update it with Homebrew, not `herdr update`.
-   Interactive SSH terminals start herdr automatically, except inside VS Code and herdr. Set `DOTFILES_NO_HERDR=1` to opt out, or use `ssh -t HOST 'bash --noprofile --norc -i'` for a recovery shell.
-   `Ctrl+b q` detaches; with the automatic `exec` startup, detaching also ends the SSH login.
-   Apply config changes with `herdr server reload-config`.
-   Only [files/herdr/config.toml](files/herdr/config.toml) is managed. Do not commit session snapshots, logs, sockets, or other runtime state from `~/.config/herdr`.
-   Existing tmux installations and configuration are left untouched and unmanaged.

### Tab names

Interactive fish shells inside herdr name numbered tabs after the foreground command via [files/scripts/herdr-tab-names.mjs](files/scripts/herdr-tab-names.mjs). Manually renamed tabs are left alone. Open a new fish shell inside herdr to pick up updates.

### Copilot CLI settings

`~/.copilot/settings.json` is merged, not symlinked, because Copilot CLI rewrites the file atomically. The merge is one way: keys tracked in `files/copilot/settings.json` are restored on every run, and local-only keys such as the `hooks` block are preserved. To keep a local change everywhere, copy it into `files/copilot/settings.json`.

The playbook reports local-only keys after the Copilot tasks. Check by hand with:

```bash
$ python3 files/scripts/copilot-settings-drift.py
```

`~/.copilot/hooks` is a symlink into this repository, so `herdr integration install copilot` writes into the working tree. Expect `files/copilot/hooks/herdr-agent-state.sh` to change when herdr updates.

### Notifications

herdr delivers agent notifications through the outer terminal (`[ui.toast] delivery = "terminal"`), for both finished and needs-attention events.

Detection depends on `TERM_PROGRAM`, which SSH does not forward. The login profile mirrors it into `LC_TERM_PROGRAM` and restores it on the far side. On Windows, `WSLENV` must list `TERM_PROGRAM` for it to reach WSL.

`TERM_PROGRAM` is intentionally absent inside panes; only the attached client matters. Verify with `herdr notification show test`.

herdr keeps one agent state per pane and infers it from the visible screen, so the background sessions of a Copilot process never notify. `files/copilot/hooks/session-notify.sh` closes that gap: it runs on `Stop` and pushes its own toast through the socket API. Its text is `<directory>: <last reply>`, read from the transcript the hook is handed, instead of the generic `copilot finished: <workspace>` that herdr emits, so the visible session can produce two toasts for one event.

The hook is also registered for `Notification`, which would cover permission prompts, but that event never fired in 1.0.84. `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SubagentStop` and `SessionEnd` all fire; `Stop` is raised once per turn, not once per tool call.

Subagents raise `Stop` too, which would notify in the middle of a turn. They report their parent's `transcript_path` under their own `session_id`, and the hook drops the event on that mismatch.

`[ui.toast] delivery` must stay `terminal`. `off` also drops `notification.show` on the client side, which would silence the hook as well.

References: [configuration](https://herdr.dev/docs/configuration/), [session state](https://herdr.dev/docs/session-state/), [integrations](https://herdr.dev/docs/integrations/).
