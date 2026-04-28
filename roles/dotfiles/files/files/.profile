# ~/.profile: executed by the command interpreter for login shells.
# This file is not read by bash(1), if ~/.bash_profile or ~/.bash_login
# exists.
# see /usr/share/doc/bash/examples/startup-files for examples.
# the files are located in the bash-doc package.

# the default umask is set in /etc/profile; for setting the umask
# for ssh logins, install and configure the libpam-umask package.
#umask 022

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

AddToPATH() {
    if [ -n "$PATH" ]; then
        case ":$PATH:" in
        *":$1:"*) : ;; # already there
        *) export PATH="$1:$PATH" ;;
        esac
    else
        export PATH="$1"
    fi
}

AddToLDPATH() {
    if [ -n "$LD_LIBRARY_PATH" ]; then
        case ":$LD_LIBRARY_PATH:" in
        *":$1:"*) : ;; # already there
        *) export LD_LIBRARY_PATH="$1:$LD_LIBRARY_PATH" ;;
        esac
    else
        export LD_LIBRARY_PATH="$1"
    fi
}

# export
export EDITOR=vim
if glxinfo >/dev/null 2>&1; then
    if tty | grep pts >/dev/null 2>&1; then
        export LIBGL_ALWAYS_INDIRECT=1
    fi
else
    :
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ]; then
    AddToPATH "$HOME/bin"
fi

# brew
if [ -f "/home/linuxbrew/.linuxbrew/bin/brew" ]; then
    eval $(/home/linuxbrew/.linuxbrew/bin/brew shellenv)
fi
if [ -f "/opt/homebrew/bin/brew" ]; then
    eval $(/opt/homebrew/bin/brew shellenv)
fi
if [ -f "/usr/local/bin/brew" ]; then
    eval $(/usr/local/bin/brew shellenv)
fi

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
