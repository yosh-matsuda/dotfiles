function code-remote --description 'Print a clickable Remote-SSH link for VS Code'
    set -l dir .
    test (count $argv) -gt 0; and set dir $argv[1]
    if not test -d $dir
        echo "code-remote: not a directory: $dir" >&2
        return 1
    end
    set dir (realpath -- $dir); or return 1
    set -l host (hostname -s)
    set -q VSCODE_SSH_HOST; and set host $VSCODE_SSH_HOST
    set -l uri "vscode-remote://ssh-remote+$host"(string escape --style=url -- $dir)
    # WezTerm opens this OSC 8 link via its open-uri handler; herdr drops OSC 1337 but keeps OSC 8
    printf '\e]8;;%s\e\\\\Open in VS Code: %s:%s\e]8;;\e\\\\\n' $uri $host $dir
end
