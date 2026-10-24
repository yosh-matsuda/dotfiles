function code-remote --description 'Open a directory or file in VS Code over WSL or a connected window, else print a clickable Remote link'
    set -l target .
    test (count $argv) -gt 0; and set target $argv[1]
    if not test -e $target
        echo "code-remote: no such file or directory: $target" >&2
        return 1
    end
    set target (realpath -- $target); or return 1

    # On WSL, `code` (VS Code's Windows launcher, or the remote CLI in a VS Code terminal) opens the folder through the WSL remote;
    # the Remote-SSH fallback below would reach this machine over SSH instead.
    set -l wsl_distro
    if string match -qi '*microsoft*' -- (cat /proc/sys/kernel/osrelease 2>/dev/null)
        command -q code; and command code $target; and return 0
        set -q WSL_DISTRO_NAME; and set wsl_distro $WSL_DISTRO_NAME
    end

    set -l runtime_dir /tmp
    set -q XDG_RUNTIME_DIR; and set runtime_dir $XDG_RUNTIME_DIR

    # A window behind others throttles its timers and answers the probe below only minutes later, yet acts on an open request at once.
    # So find the extension hosts a window is attached to from this side alone: each shares a unix socket with the window's Remote-SSH
    # exec server (command-shell), or without one, holds a TCP connection to the port its server listens on.
    if command -q ss; and command -q pgrep
        set -l hosts (pgrep -u (id -u) -f -- 'bootstrap-fork --type=extensionHost')
        set -l shells (pgrep -u (id -u) -f -- '/code-[0-9a-f]+ command-shell ')
        set -l parents
        for h in $hosts
            set -a parents $h:(command ps -o ppid= -p $h | string trim)
        end
        set -l attached (command ss -Hanp -A tcp,unix_stream 2>/dev/null | awk -v dir=$runtime_dir/vscode-ipc- -v hosts=" $hosts " -v shells=" $shells " -v parents="$parents" '
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
        if set -q attached[1]
            set -l newest (command ps -o pid= --sort=start_time -p (string split -f1 ' ' -- $attached | string join ,) | string trim)[-1]
            set -l socket (string replace -rf -- "^$newest " '' $attached)
            # The extension host's own server ships the CLI that matches it.
            set -l cli (command readlink /proc/$newest/exe | string replace -r '/[^/]*$' '')/bin/remote-cli/code
            if set -q socket[1]; and test -x "$cli"
                VSCODE_IPC_HOOK_CLI=$socket[1] $cli $target 2>/dev/null; and return 0
            end
        end
    end

    set -l clis $HOME/.vscode-server/cli/servers/*/server/bin/remote-cli/code $HOME/.vscode-server/bin/*/bin/remote-cli/code
    set -l sockets $runtime_dir/vscode-ipc-*.sock
    # Socket files of exited servers linger; /proc/net/unix lists only the ones still bound.
    test -r /proc/net/unix; and set sockets (string match -- "$runtime_dir/vscode-ipc-*.sock" (awk '{print $NF}' /proc/net/unix) | sort -u)
    if set -q clis[1]; and set -q sockets[1]
        set -l cli (command ls -t $clis)[1]
        # Closed windows' sockets may still accept and drop open requests; --list-extensions answers only with a window attached (--status is far slower).
        # Probe in parallel via sh so fish prints no job notices, and take the first socket that answers.
        set -l socket (command sh -c 'cli=$1; shift; for s; do (VSCODE_IPC_HOOK_CLI=$s timeout 5 "$cli" --list-extensions >/dev/null 2>&1 && echo "$s") & done | head -n 1' sh $cli $sockets)
        if set -q socket[1]
            VSCODE_IPC_HOOK_CLI=$socket $cli $target 2>/dev/null; and return 0
        end
    end

    set -l host (hostname -s)
    set -q VSCODE_SSH_HOST; and set host $VSCODE_SSH_HOST
    set -l authority ssh-remote+$host
    if set -q wsl_distro[1]
        set host "WSL: $wsl_distro"
        set authority wsl+(string escape --style=url -- $wsl_distro)
    end
    set -l uri "vscode://vscode-remote/$authority"(string escape --style=url -- $target)
    # VS Code treats these paths as folders unless they end in :line, and reuses the last active window without windowId=_blank.
    if test -d $target
        set uri "$uri?windowId=_blank"
    else
        set uri "$uri:1"
    end
    # herdr drops OSC 1337, and with mouse capture on (herdr >= 0.9.4) it no longer passes OSC 8 to the outer terminal
    # and opens only http(s) links itself, so the bare URI is printed too for the outer terminal's own URL detection.
    printf '\e]8;;%s\e\\\\Open in VS Code: %s:%s\e]8;;\e\\\\\n%s\n' $uri $host $target $uri
end
