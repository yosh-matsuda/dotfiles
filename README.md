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

First, copy the local example files and edit them for your environment.

```bash
$ cp local.hosts.yml.example local.hosts.yml
$ cp local.vars.yml.example local.vars.yml
```

Then run the playbook:

```bash
$ ansible-playbook site.yml --ask-become-pass
```

On Ubuntu 26.04 with sudo-rs, Ansible needs `ANSIBLE_BECOME_EXE=sudo.ws`:

```bash
$ ANSIBLE_BECOME_EXE=sudo.ws ansible-playbook site.yml --ask-become-pass
```

Both `local.hosts.yml` and `local.vars.yml` are Git-ignored. Keep the example files as tracked templates and add your local inventory entries or private variables only to the copied files. `local.vars.yml` is used by templated dotfiles under [files/templates](files/templates), such as [files/templates/.gitconfig](files/templates/.gitconfig).

Repository-local defaults such as the inventory path, roles path, and collections path are configured in `ansible.cfg`, so the commands above can be run from the repository root without extra `-i` or path options.

Main settings live under [files](files). Package lists and shared variables are defined in [group_vars/all.yml](group_vars/all.yml).

## herdr

Homebrew installs herdr through the existing package role. Update it with Homebrew, not `herdr update`.

[files/herdr/config.toml](files/herdr/config.toml) is linked individually to `~/.config/herdr/config.toml`. An existing regular file is backed up before linking. The surrounding directory remains local: do not commit session snapshots, pane history, logs, sockets, or other runtime state. Common custom scripts or sound assets can also be managed when needed.

The login profile starts herdr only for interactive SSH terminals outside VS Code and herdr. Set `DOTFILES_NO_HERDR=1` in the login environment to bypass automatic startup. For a one-off recovery shell that skips the login profile and bashrc, use `ssh -t HOST 'bash --noprofile --norc -i'`.

Run `herdr` to start or reattach manually. `Ctrl+b q` detaches; when started automatically with `exec`, detaching also ends the SSH login. After editing settings, use `herdr server reload-config` to reload supported settings.

Existing tmux installations, configuration, launcher symlinks, and plugin directories are left untouched. This playbook no longer manages them or enforces their absence.

### Tab names

Interactive fish shells inside herdr start [files/scripts/herdr-tab-names.mjs](files/scripts/herdr-tab-names.mjs) using the installed Node.js. A background worker per session uses the herdr 0.9.0 socket API to name numbered tabs after the foreground command in their selected pane. It reacts to events and checks once a second to cover process changes without title notifications. Command arguments are not included; at the prompt the label is the shell name, usually `fish`.

Existing named tabs are left alone. Renaming an automatically managed tab to a different name stops updates for that tab. A manually chosen name identical to the default tab number cannot be distinguished from an unnamed tab.

The worker stores its PID, assigned labels, and error log under `${XDG_STATE_HOME:-~/.local/state}/herdr-tab-names/`, outside this repository. It exits if the session connection fails; opening another fish shell starts it again. Open a new fish shell inside herdr to activate the feature after updating dotfiles. No changes to the outer terminal title are made.

### Agent integrations

Integration choices and portable configuration can be managed in dotfiles. Inspect integrations with `herdr integration status`; generated hooks and plugins should match the installed herdr version. Review changes to agent configuration before enabling an integration, especially when the agent's config or hooks already link into this repository. In herdr 0.9.0, the Copilot integration provides session identity for restore; agent state still comes from screen detection, so the integration is not required for notifications.

The playbook runs `herdr integration install copilot` when `herdr` is on `PATH`; re-running it is idempotent. Install other integrations manually with `herdr integration install <agent>`.

`~/.copilot/settings.json` is not symlinked. Copilot CLI rewrites it atomically, which replaces a symlink with a regular file, so the playbook merges `files/copilot/settings.json` into the live file instead. Tracked keys win; keys written locally, such as the `hooks` block from `herdr integration install`, are preserved. The `hooks` block is deliberately untracked because herdr writes an absolute path into it; herdr matches its own entry by exact command string, so editing that command makes the next install append a duplicate that fires the hook twice.

Unlike a symlink this merge is one way. Settings changed through the CLI stay on that machine, and settings tracked here are restored on the next playbook run. To keep a local change everywhere, copy it into `files/copilot/settings.json` and re-run the playbook. [files/scripts/copilot-settings-drift.py](files/scripts/copilot-settings-drift.py) reports what differs:

```bash
python3 files/scripts/copilot-settings-drift.py
```

It lists `untracked` keys that exist only locally, `drift` where a tracked key was changed locally and will be restored, and `missing` where a tracked key is not applied yet. Pass `--json` for machine-readable output; `COPILOT_HOME` selects a different live directory.

`~/.copilot/hooks` stays a symlink into this repository, so `herdr integration install copilot` writes `files/copilot/hooks/herdr-agent-state.sh` directly into the working tree. Expect that file to change when herdr bumps its integration version.

References: [configuration](https://herdr.dev/docs/configuration/), [session state](https://herdr.dev/docs/session-state/), and [integrations](https://herdr.dev/docs/integrations/).

### Notifications

Herdr owns agent notifications with `[ui.toast] delivery = "terminal"`. It asks the outer terminal to display notifications for background agents that finish or need input. This supports Windows WezTerm connections over SSH, including through WSL, while attached. Windows notification settings and WezTerm's notification handling still apply. Herdr 0.9.0 suppresses notifications for its active tab, even if you switch to another Windows application.

The legacy Copilot OSC notification hooks are removed to avoid a second notification path. Restart an already-running Copilot CLI after updating to stop using previously loaded hooks. Apply herdr settings with `herdr server reload-config`.

### Validation

```bash
ansible-playbook site.yml --syntax-check
```

Verify SSH reattachment, terminal input, clipboard, and notifications on a configured machine.
