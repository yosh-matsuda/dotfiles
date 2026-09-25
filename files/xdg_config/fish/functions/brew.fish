function brew --description 'Run Homebrew as the owner of HOMEBREW_PREFIX'
    if not set -q HOMEBREW_PREFIX; or test -O $HOMEBREW_PREFIX
        command brew $argv
        return
    end
    # cd to the owner's home: brew fails when the caller's cwd is unreadable to it
    command sudo -u (stat -c %U $HOMEBREW_PREFIX) -H \
        sh -c 'cd && eval "$("$0" shellenv)" && exec "$0" "$@"' $HOMEBREW_PREFIX/bin/brew $argv
end
