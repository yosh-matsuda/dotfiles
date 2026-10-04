#!/usr/bin/env bash
# Copilot CLI status line. Reads the session JSON on stdin and prints one line.
set -u

payload=$(cat)

IFS=$'\x1f' read -r cwd model pct dur_ms added removed < <(
    jq -r '[
        (.cwd // ""),
        (.model.display_name // .model.id // "?"),
        (.context_window.current_context_used_percentage // .context_window.used_percentage // ""),
        (.cost.total_duration_ms // 0),
        (.cost.total_lines_added // 0),
        (.cost.total_lines_removed // 0)
    ] | map(tostring) | join("\u001f")' <<<"$payload" 2>/dev/null
)

dim=$'\e[2m'; reset=$'\e[0m'
green=$'\e[32m'; yellow=$'\e[33m'; red=$'\e[31m'; cyan=$'\e[36m'
sep=" ${dim}│${reset} "

parts=("$(date +%H:%M)")

if [ -n "${cwd:-}" ]; then
    branch=$(git -C "$cwd" symbolic-ref --short -q HEAD 2>/dev/null ||
        git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
    if [ -n "$branch" ]; then
        dirty=""
        [ -n "$(git -C "$cwd" status --porcelain -uno 2>/dev/null | head -1)" ] && dirty="*"
        parts+=("${cyan}${branch}${dirty}${reset}")
    fi
fi

parts+=("${model:-?}")

if [ -n "${pct:-}" ]; then
    p=$(printf '%.0f' "$pct")
    color=$green
    [ "$p" -ge 50 ] && color=$yellow
    [ "$p" -ge 80 ] && color=$red
    filled=$((p / 10)); [ "$filled" -gt 10 ] && filled=10
    bar=""
    for ((i = 0; i < 10; i++)); do
        if [ "$i" -lt "$filled" ]; then bar+="█"; else bar+="░"; fi
    done
    parts+=("ctx ${color}${bar} ${p}%${reset}")
fi

dur_ms=${dur_ms:-0}
s=$(( ${dur_ms%.*} / 1000 ))
parts+=("$(printf '%d:%02d' $((s / 3600)) $(((s % 3600) / 60)))")

if [ "${added:-0}" != 0 ] || [ "${removed:-0}" != 0 ]; then
    parts+=("${green}+${added}${reset}/${red}-${removed}${reset}")
fi

out=""
for part in "${parts[@]}"; do
    [ -n "$out" ] && out+="$sep"
    out+="$part"
done
printf '%s\n' "$out"
