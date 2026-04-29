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

Default:

```bash
$ ansible-playbook -i hosts.yml site.yml --ask-become-pass
```

On Ubuntu 26.04 with sudo-rs, Ansible needs `ANSIBLE_BECOME_EXE=sudo.ws`:

```bash
$ ANSIBLE_BECOME_EXE=sudo.ws ansible-playbook -i hosts.yml site.yml --ask-become-pass
```

Main settings live under [roles/dotfiles/files](roles/dotfiles/files). Package lists and shared variables are defined in [group_vars/all.yml](group_vars/all.yml).

## Templated dotfiles

Files placed under [files/templates](files/templates) are rendered with Ansible's template module and copied into the target home directory instead of being symlinked.

Templated dotfiles can read private values from a Git-ignored [local.vars.yml.example](local.vars.yml.example) copied to local.vars.yml.

For example, [files/templates/.gitconfig](files/templates/.gitconfig) reads these variables at playbook runtime:

-   `dotfiles_git_user_name`
-   `dotfiles_git_user_email`

Create local.vars.yml next to site.yml before running Ansible.

```yaml
dotfiles_git_user_name: Your Name
dotfiles_git_user_email: you@example.com
```
