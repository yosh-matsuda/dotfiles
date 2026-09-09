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

### Agent integrations

Integration choices and portable configuration can be managed in dotfiles. Install the official integration on each machine with `herdr integration install <agent>` and inspect it with `herdr integration status`; generated hooks and plugins should match the installed herdr version. Review changes to agent configuration before enabling an integration, especially when the agent's config or hooks already link into this repository. This playbook does not install integrations or change the existing Copilot hooks.

References: [configuration](https://herdr.dev/docs/configuration/), [session state](https://herdr.dev/docs/session-state/), and [integrations](https://herdr.dev/docs/integrations/).

### Validation

```bash
ansible-playbook site.yml --syntax-check
```

Verify SSH reattachment, terminal input, clipboard, and notifications on a configured machine.
