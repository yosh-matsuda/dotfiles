#!/usr/bin/env bash
# Installs what the playbook needs, clones this repository into ~/dotfiles, and runs the playbook.
# Supports Ubuntu, including WSL, and macOS with Homebrew. Safe to run again.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/yosh-matsuda/dotfiles/main/bootstrap.sh)"
set -euo pipefail

repo_url=https://github.com/yosh-matsuda/dotfiles.git
branch=${DOTFILES_BRANCH:-main}
repo_dir=$HOME/dotfiles

case "$(uname -s)" in
Linux)
    if ! command -v git >/dev/null || ! command -v ansible-playbook >/dev/null; then
        if ! command -v apt-get >/dev/null; then
            echo "Install git and Ansible first; only Ubuntu is set up automatically." >&2
            exit 1
        fi
        sudo apt-get update
        sudo apt-get install -y git ansible
    fi
    ;;
Darwin)
    if ! xcode-select -p >/dev/null 2>&1; then
        xcode-select --install
        echo "Run this script again after the Command Line Tools are installed." >&2
        exit 1
    fi
    if ! command -v ansible-playbook >/dev/null; then
        if ! command -v brew >/dev/null; then
            echo "Install Homebrew first: https://brew.sh" >&2
            exit 1
        fi
        brew install ansible
    fi
    ;;
*)
    echo "Unsupported system: $(uname -s)" >&2
    exit 1
    ;;
esac

if [ ! -d "$repo_dir/.git" ]; then
    if [ -e "$repo_dir" ]; then
        echo "$repo_dir exists but is not a git repository" >&2
        exit 1
    fi
    git clone --branch "$branch" "$repo_url" "$repo_dir"
fi

cd "$repo_dir"
if [ ! -e local.hosts.yml ]; then
    cp local.hosts.yml.example local.hosts.yml
fi
ansible-galaxy collection install -r collections/requirements.yml
ansible-playbook site.yml --ask-become-pass
