#!/usr/bin/env bash
# Show the link that open-link.py passes in CODE_REMOTE_LINK until a key is pressed or the outer terminal loses focus.
# herdr handles Ctrl+click on the link itself and never passes the click to this pane. VS Code takes the focus from
# WezTerm when the click opens it, and herdr forwards that to the focused pane as a focus-out report (CSI O) once the
# pane turns on focus reporting (mode 1004).
printf '%s\n' "$CODE_REMOTE_LINK"
printf '\e[?1004h'
trap "printf '\e[?1004l'" EXIT
printf 'Ctrl+click the link, or press any key to close '
while IFS= read -rsn 1 key; do
    if [[ $key == $'\e' ]]; then
        # herdr may report focus-in (CSI I) as the pane takes the focus; only that keeps the pane open.
        IFS= read -rsn 2 -t 0.05 rest
        [[ $rest == '[I' ]] && continue
    fi
    break
done
