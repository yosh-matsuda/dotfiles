function code-remote --description 'Open a directory in a connected VS Code window, else print a clickable Remote-SSH link'
    set -l dir .
    test (count $argv) -gt 0; and set dir $argv[1]
    if not test -d $dir
        echo "code-remote: not a directory: $dir" >&2
        return 1
    end
    set dir (realpath -- $dir); or return 1

    set -l clis $HOME/.vscode-server/cli/servers/*/server/bin/remote-cli/code $HOME/.vscode-server/bin/*/bin/remote-cli/code
    set -l runtime_dir /tmp
    set -q XDG_RUNTIME_DIR; and set runtime_dir $XDG_RUNTIME_DIR
    set -l sockets $runtime_dir/vscode-ipc-*.sock
    if set -q clis[1]; and set -q sockets[1]
        set -l cli (command ls -t $clis)[1]
        # Closed windows leave stale sockets behind; remote-cli exits 1 when it cannot connect.
        for socket in (command ls -t $sockets)
            VSCODE_IPC_HOOK_CLI=$socket $cli $dir 2>/dev/null; and return 0
        end
    end

    set -l host (hostname -s)
    set -q VSCODE_SSH_HOST; and set host $VSCODE_SSH_HOST
    set -l uri "vscode-remote://ssh-remote+$host"(string escape --style=url -- $dir)
    # WezTerm opens this OSC 8 link via its open-uri handler; herdr drops OSC 1337 but keeps OSC 8
    printf '\e]8;;%s\e\\\\Open in VS Code: %s:%s\e]8;;\e\\\\\n' $uri $host $dir
end
