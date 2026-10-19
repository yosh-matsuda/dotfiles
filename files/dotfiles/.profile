# ~/.profile: executed by the command interpreter for login shells.
# This file is not read by bash(1), if ~/.bash_profile or ~/.bash_login
# exists.
# see /usr/share/doc/bash/examples/startup-files for examples.
# the files are located in the bash-doc package.

# the default umask is set in /etc/profile; for setting the umask
# for ssh logins, install and configure the libpam-umask package.
#umask 022

PrependUniquePath() {
    var_name="$1"
    new_entry="$2"
    eval current_value="\${$var_name}"

    if [ -n "$current_value" ]; then
        case ":$current_value:" in
        *":$new_entry:"*) : ;; # already there
        *) eval export "$var_name=\"$new_entry:$current_value\"" ;;
        esac
    else
        eval export "$var_name=\"$new_entry\""
    fi
}

AddToPATH() {
    PrependUniquePath PATH "$1"
}

AddToLDPATH() {
    PrependUniquePath LD_LIBRARY_PATH "$1"
}

# export
export EDITOR=vim
if glxinfo >/dev/null 2>&1 && tty | grep pts >/dev/null 2>&1; then
    export LIBGL_ALWAYS_INDIRECT=1
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ]; then
    AddToPATH "$HOME/bin"
fi

# brew
for brew_bin in \
    "/home/linuxbrew/.linuxbrew/bin/brew" \
    "/opt/homebrew/bin/brew" \
    "/usr/local/bin/brew"
do
    if [ -f "$brew_bin" ]; then
        eval "$($brew_bin shellenv)"
    fi
done

# CUDA
if [ -d "/usr/local/cuda/bin" ]; then
    AddToPATH "/usr/local/cuda/bin"
fi
if [ -d "/usr/local/cuda/lib64" ]; then
    AddToLDPATH "/usr/local/cuda/lib64"
fi

# set .local
if [ -d "$HOME/.local/bin" ]; then
    AddToPATH "$HOME/.local/bin"
fi

# WSL sets WSL_DISTRO_NAME and appends the Windows PATH only for processes it starts itself, so services of the
# systemd user manager lack both, such as a herdr server that Pairfob starts. VS Code's `code` script then misses
# WSL and hangs, so restore them from the UNC path of / and from cmd.exe.
if [ -z "${WSL_DISTRO_NAME:-}" ] && grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
    wsl_root=$(wslpath -w / 2>/dev/null)
    wsl_root=${wsl_root#\\\\*\\}
    if [ -n "${wsl_root%\\}" ]; then
        export WSL_DISTRO_NAME="${wsl_root%\\}"
        # cmd.exe warns about a UNC working directory, so it starts from a Windows drive.
        win_path=$(cd /mnt/c 2>/dev/null && /mnt/c/Windows/System32/cmd.exe /d /c 'echo %PATH%' </dev/null 2>/dev/null | tr -d '\r')
        old_ifs=$IFS
        IFS=';'
        for win_dir in $win_path; do
            [ -n "$win_dir" ] || continue
            win_dir=$(wslpath -u "$win_dir" 2>/dev/null) || continue
            case ":$PATH:" in
            *":$win_dir:"*) : ;;
            *) PATH="$PATH:$win_dir" ;;
            esac
        done
        IFS=$old_ifs
        export PATH
        unset old_ifs win_dir win_path
    fi
    unset wsl_root
fi

# herdr picks its notification escape sequence from TERM_PROGRAM, which ssh drops;
# relay it through LC_* because that is all sshd accepts by default.
case "${TERM_PROGRAM:-}" in
WezTerm | ghostty | iTerm.app) export LC_TERM_PROGRAM="$TERM_PROGRAM" ;;
esac
# Only the herdr client needs it; in a pane, LC_TERM_PROGRAM names the terminal that started the server.
if [ -z "${TERM_PROGRAM:-}" ] && [ -n "${LC_TERM_PROGRAM:-}" ] && [ "${HERDR_ENV:-}" != "1" ]; then
    export TERM_PROGRAM="$LC_TERM_PROGRAM"
fi

IsInteractiveTerminal() {
    # if interactive shell
    if case $- in *i*) true ;; *) false ;; esac; then
        # if FD is a file descriptor that is associated with a terminal.
        if test -t 1; then
            return 0
        fi
    fi
    return 1
}

if IsInteractiveTerminal; then
    if [ -n "${SSH_CONNECTION:-}" ] &&
        [ "${TERM_PROGRAM:-}" != "vscode" ] &&
        [ "${HERDR_ENV:-}" != "1" ] &&
        [ "${DOTFILES_NO_HERDR:-}" != "1" ] &&
        command -v herdr >/dev/null 2>&1; then
        # exec しないのは、デタッチ後もログインシェルを残して herdr 自体の更新をできるようにするため
        herdr
    fi
fi

# if running bash
if [ -n "$BASH_VERSION" ]; then
    # include .bashrc if it exists
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi
