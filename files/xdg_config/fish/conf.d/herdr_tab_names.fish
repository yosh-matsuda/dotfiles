if status is-interactive; and set -q HERDR_ENV; and test "$HERDR_ENV" = 1; and set -q HERDR_SOCKET_PATH; and command -q node
    set -l tab_names_script $HOME/dotfiles/files/scripts/herdr-tab-names.mjs
    if test -f "$tab_names_script"
        command node "$tab_names_script" --start >/dev/null 2>&1
    end
end