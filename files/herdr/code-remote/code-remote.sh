#!/usr/bin/env bash
# Open a directory or file in VS Code over WSL or a connected window, else print a clickable Remote link.
# Usage: code-remote.sh [-g|--goto] [--] [PATH]
# -g takes FILE:LINE[:COLUMN] like `code --goto`. Both the herdr plugin in this directory and the herdr shortcut in
# files/herdr/config.toml run this script, so it depends on bash alone, not on fish.

code-remote() {
    local goto=
    while (($# > 0)); do
        case $1 in
        -g | --goto) goto=1; shift ;;
        --) shift; break ;;
        -?*) echo "code-remote: unknown option: $1" >&2; return 2 ;;
        *) break ;;
        esac
    done
    local target=. position=
    (($# > 0)) && target=$1
    if [[ -n $goto && $target =~ ^(.+):([0-9]+):([0-9]+)$ ]]; then
        target=${BASH_REMATCH[1]}
        position=${BASH_REMATCH[2]}:${BASH_REMATCH[3]}
    elif [[ -n $goto && $target =~ ^(.+):([0-9]+)$ ]]; then
        target=${BASH_REMATCH[1]}
        position=${BASH_REMATCH[2]}
    fi
    if [[ ! -e $target ]]; then
        echo "code-remote: no such file or directory: $target" >&2
        return 1
    fi
    target=$(realpath -- "$target") || return 1
    local open_args=("$target")
    [[ -n $position && -f $target ]] && open_args=(--goto "$target:$position")

    # On WSL, `code` (VS Code's Windows launcher, or the remote CLI in a VS Code terminal) opens the folder through the WSL remote;
    # the Remote-SSH fallback below would reach this machine over SSH instead.
    # WSL is detected from the kernel: when the herdr shortcut tested WSL_DISTRO_NAME instead, panes on a saved SSH machine exited 127.
    local wsl_distro=
    if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
        command -v code >/dev/null && command code "${open_args[@]}" && return 0
        wsl_distro=${WSL_DISTRO_NAME:-}
    fi

    local runtime_dir=${XDG_RUNTIME_DIR:-/tmp}

    # A window behind others throttles its timers and answers the probe below only minutes later, yet acts on an open request at once.
    # So find the extension hosts a window is attached to from this side alone: each shares a unix socket with the window's Remote-SSH
    # exec server (command-shell), or without one, holds a TCP connection to the port its server listens on.
    if command -v ss >/dev/null && command -v pgrep >/dev/null; then
        local hosts shells parents=() h ppid attached
        mapfile -t hosts < <(pgrep -u "$(id -u)" -f -- 'bootstrap-fork --type=extensionHost')
        mapfile -t shells < <(pgrep -u "$(id -u)" -f -- '/code-[0-9a-f]+ command-shell ')
        for h in "${hosts[@]}"; do
            ppid=$(command ps -o ppid= -p "$h") && parents+=("$h:${ppid// /}")
        done
        mapfile -t attached < <(command ss -Hanp -A tcp,unix_stream 2>/dev/null | awk -v dir="$runtime_dir/vscode-ipc-" -v hosts=" ${hosts[*]} " -v shells=" ${shells[*]} " -v parents="${parents[*]}" '
            function port(a) { sub(/.*:/, "", a); return a }
            BEGIN { n = split(parents, p, " "); for (i = 1; i <= n; i++) { split(p[i], q, ":"); parent[q[1]] = q[2] } }
            !match($0, /pid=[0-9]+/) { next }
            { pid = substr($0, RSTART + 4, RLENGTH - 4) }
            $1 == "u_str" && $2 == "LISTEN" && index($5, dir) == 1 { cli[pid] = $5 }
            $1 == "u_str" && $2 == "ESTAB" { owner[$6] = pid; if (index(shells, " " pid " ")) linked[$8] = 1 }
            $1 == "tcp" && $2 == "LISTEN" { listening[pid ":" port($5)] = 1 }
            $1 == "tcp" && $2 == "ESTAB" { conns[pid] = conns[pid] " " port($5) }
            END {
                for (i in linked) if ((i in owner) && index(hosts, " " owner[i] " ")) live[owner[i]] = 1
                for (h in parent) { n = split(conns[h], c, " "); for (i = 1; i <= n; i++) if ((parent[h] ":" c[i]) in listening) live[h] = 1 }
                for (h in live) if (h in cli) print h, cli[h]
            }')
        if ((${#attached[@]})); then
            local pids newest socket= a cli
            pids=$(printf '%s,' "${attached[@]%% *}")
            newest=$(command ps -o pid= --sort=start_time -p "${pids%,}" | tail -n 1)
            newest=${newest// /}
            for a in "${attached[@]}"; do
                [[ $a == "$newest "* ]] && socket=${a#* } && break
            done
            # The extension host's own server ships the CLI that matches it.
            cli=$(command readlink "/proc/$newest/exe")
            cli=${cli%/*}/bin/remote-cli/code
            if [[ -n $socket && -x $cli ]]; then
                VSCODE_IPC_HOOK_CLI=$socket "$cli" "${open_args[@]}" 2>/dev/null && return 0
            fi
        fi
    fi

    local clis sockets
    clis=$(shopt -s nullglob; printf '%s\n' "$HOME"/.vscode-server/cli/servers/*/server/bin/remote-cli/code "$HOME"/.vscode-server/bin/*/bin/remote-cli/code)
    sockets=$(shopt -s nullglob; printf '%s\n' "$runtime_dir"/vscode-ipc-*.sock)
    # Socket files of exited servers linger; /proc/net/unix lists only the ones still bound.
    [[ -r /proc/net/unix ]] && sockets=$(awk -v dir="$runtime_dir/vscode-ipc-" 'index($NF, dir) == 1 && $NF ~ /\.sock$/ { print $NF }' /proc/net/unix | sort -u)
    if [[ -n $clis && -n $sockets ]]; then
        local cli socket
        mapfile -t clis <<<"$clis"
        mapfile -t sockets <<<"$sockets"
        cli=$(command ls -t "${clis[@]}" | head -n 1)
        # Closed windows' sockets may still accept and drop open requests; --list-extensions answers only with a window attached (--status is far slower).
        # Probe in parallel and take the first socket that answers.
        socket=$(for s in "${sockets[@]}"; do
            (VSCODE_IPC_HOOK_CLI=$s timeout 5 "$cli" --list-extensions >/dev/null 2>&1 && echo "$s") &
        done | head -n 1)
        if [[ -n $socket ]]; then
            VSCODE_IPC_HOOK_CLI=$socket "$cli" "${open_args[@]}" 2>/dev/null && return 0
        fi
    fi

    local host authority uri
    host=${VSCODE_SSH_HOST:-$(hostname -s)}
    authority=ssh-remote+$host
    if [[ -n $wsl_distro ]]; then
        host="WSL: $wsl_distro"
        authority=wsl+$(_code_remote_url_escape "$wsl_distro")
    fi
    uri="vscode://vscode-remote/$authority$(_code_remote_url_escape "$target")"
    # VS Code treats these paths as folders unless they end in :line, and reuses the last active window without windowId=_blank.
    if [[ -d $target ]]; then
        uri+='?windowId=_blank'
    else
        uri+=:${position:-1}
    fi
    # herdr drops OSC 1337, and with mouse capture on (herdr >= 0.9.4) it no longer passes OSC 8 to the outer terminal
    # and opens only http(s) links itself, so the bare URI is printed too for the outer terminal's own URL detection.
    # The label links to the URI through vscode.dev's redirect page, an https URL that herdr opens on Ctrl+click; the
    # dotfiles xdg-open takes the URI out of it and has WezTerm open it without a browser.
    local redirect="https://vscode.dev/redirect?url=$(_code_remote_url_escape "$uri")"
    printf '\e]8;;%s\e\\Open in VS Code: %s:%s\e]8;;\e\\\n%s\n' "$redirect" "$host" "$target" "$uri"
}

# Same escaping as fish's `string escape --style=url`.
_code_remote_url_escape() {
    local LC_ALL=C s=$1 out= c i
    for ((i = 0; i < ${#s}; i++)); do
        c=${s:i:1}
        case $c in
        [a-zA-Z0-9/._~-]) out+=$c ;;
        *) printf -v c '%%%02X' "'$c"; out+=$c ;;
        esac
    done
    printf '%s' "$out"
}

code-remote "$@"
