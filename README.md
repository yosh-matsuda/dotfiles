# dotfiles

Ansible-based dotfiles for my local development environment.

This repository applies shell settings, XDG config files, and CLI tools on Ubuntu, WSL, and macOS. It is meant to be re-run to keep the machine state consistent.

## What it sets up

-   dotfiles in the home directory
-   XDG config files
-   Homebrew packages
-   pipx packages
-   tmux plugins
-   fish and fisher

## Requirements

-   Python 3
-   Ansible
-   sudo access
-   Git

Install the required Ansible collection before the first run:

```bash
$ ansible-galaxy collection install community.general
```

## Usage

First, copy the local example files and edit them for your environment.

```bash
$ cp local.hosts.yml.example local.hosts.yml
$ cp local.vars.yml.example local.vars.yml
```

Then run the playbook:

```bash
$ ansible-playbook -i local.hosts.yml site.yml --ask-become-pass
```

On Ubuntu 26.04 with sudo-rs, Ansible needs `ANSIBLE_BECOME_EXE=sudo.ws`:

```bash
$ ANSIBLE_BECOME_EXE=sudo.ws ansible-playbook -i local.hosts.yml site.yml --ask-become-pass
```

Both `local.hosts.yml` and `local.vars.yml` are Git-ignored. Keep the example files as tracked templates and add your local inventory entries or private variables only to the copied files. `local.vars.yml` is used by templated dotfiles under [files/templates](files/templates), such as [files/templates/.gitconfig](files/templates/.gitconfig).

Main settings live under [roles/dotfiles/files](roles/dotfiles/files). Package lists and shared variables are defined in [group_vars/all.yml](group_vars/all.yml).
