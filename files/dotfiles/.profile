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

IsInteractiveTerminal() {
    # if interactive shell
    if [[ $- =~ i ]]; then
        # if FD is a file descriptor that is associated with a terminal.
        if test -t 1; then
            return 0
        fi
    fi
    return 1
}

if IsInteractiveTerminal; then
    # run tmux (if ssh connected and not vscode and TMUX is not running yet)
    if [ "$SSH_CONNECTION" ] && [[ $TERM_PROGRAM != "vscode" ]] && [ -z "$TMUX" ] && type tmux 2>/dev/null 1>/dev/null; then
        exec ~/.local/bin/tmux.sh
    fi
fi

# if running bash
if [ -n "$BASH_VERSION" ]; then
    # include .bashrc if it exists
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi
