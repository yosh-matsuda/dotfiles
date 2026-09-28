function code-remote --description 'Open a directory or file in a connected VS Code window, else print a clickable Remote-SSH link'
    set -l target .
    test (count $argv) -gt 0; and set target $argv[1]
    if not test -e $target
        echo "code-remote: no such file or directory: $target" >&2
        return 1
    end
    set target (realpath -- $target); or return 1

    set -l clis $HOME/.vscode-server/cli/servers/*/server/bin/remote-cli/code $HOME/.vscode-server/bin/*/bin/remote-cli/code
    set -l runtime_dir /tmp
    set -q XDG_RUNTIME_DIR; and set runtime_dir $XDG_RUNTIME_DIR
    set -l sockets $runtime_dir/vscode-ipc-*.sock
    # Socket files of exited servers linger; /proc/net/unix lists only the ones still bound.
    test -r /proc/net/unix; and set sockets (string match -- "$runtime_dir/vscode-ipc-*.sock" (awk '{print $NF}' /proc/net/unix) | sort -u)
    if set -q clis[1]; and set -q sockets[1]
        set -l cli (command ls -t $clis)[1]
        # Sockets of closed windows may still accept and silently drop open requests; --status only answers when a window is attached.
        # Probe in parallel via sh so fish prints no job notices, and take the first socket that answers.
        set -l socket (command sh -c 'cli=$1; shift; for s; do (VSCODE_IPC_HOOK_CLI=$s timeout 5 "$cli" --status >/dev/null 2>&1 && echo "$s") & done | head -n 1' sh $cli $sockets)
        if set -q socket[1]
            VSCODE_IPC_HOOK_CLI=$socket $cli $target 2>/dev/null; and return 0
        end
    end

    set -l host (hostname -s)
    set -q VSCODE_SSH_HOST; and set host $VSCODE_SSH_HOST
    set -l uri "vscode://vscode-remote/ssh-remote+$host"(string escape --style=url -- $target)
    # VS Code treats these paths as folders unless they end in :line, and reuses the last active window without windowId=_blank.
    if test -d $target
        set uri "$uri?windowId=_blank"
    else
        set uri "$uri:1"
    end
    # herdr drops OSC 1337 but keeps OSC 8
    printf '\e]8;;%s\e\\\\Open in VS Code: %s:%s\e]8;;\e\\\\\n' $uri $host $target
end
