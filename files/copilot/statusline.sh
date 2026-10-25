#!/usr/bin/env bash
# Copilot CLI status line. Reads the session JSON on stdin and prints one line.
set -u

payload=$(cat)

IFS=$'\x1f' read -r cwd model pct dur_ms added removed session_id nano_aiu activity < <(
    jq -r '[
        (.cwd // ""),
        (.model.display_name // .model.id // "?"),
        (.context_window.current_context_used_percentage // .context_window.used_percentage // ""),
        (.cost.total_duration_ms // 0),
        (.cost.total_lines_added // 0),
        (.cost.total_lines_removed // 0),
        (.session_id // ""),
        (.ai_used.total_nano_aiu // 0),
        ([.ai_used.total_nano_aiu, .cost.total_api_duration_ms, .context_window.total_tokens,
          .cost.total_lines_added, .cost.total_lines_removed] | tostring)
    ] | map(tostring) | join("\u001f")' <<<"$payload" 2>/dev/null
)

# The clock shows when Copilot last did work. statusLine.refreshInterval reruns this
# script while the session is idle, so the time is kept per session and moves only
# when the usage counters change.
now=$(date +%s)
last_active=$now
if [ -n "${session_id:-}" ]; then
    activity_file="${XDG_RUNTIME_DIR:-/tmp}/copilot-activity-$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_-' '_')"
    read -r saved_time saved_activity 2>/dev/null <"$activity_file"
    if [ "${saved_activity:-}" = "${activity:-}" ] && [ -n "${saved_time:-}" ]; then
        last_active=$saved_time
    else
        printf '%s %s\n' "$now" "${activity:-}" >"$activity_file" 2>/dev/null
    fi
fi

aic="$(awk -v n="${nano_aiu:-0}" 'BEGIN { printf "%.2f", n / 1e9 }') AIC"
dur_ms=${dur_ms:-0}
s=$(( ${dur_ms%.*} / 1000 ))
elapsed=$(printf '%d:%02d' $((s / 3600)) $(((s % 3600) / 60)))

# Shows the session's AI credits and elapsed time as $aic and $elapsed in the herdr
# sidebar. The status line runs on every render, so a report is sent only when a value
# changes, in the background.
if [ "${HERDR_ENV:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
    state="${session_id:-} $aic $elapsed"
    cache="${XDG_RUNTIME_DIR:-/tmp}/herdr-aic-$(printf '%s' "$HERDR_PANE_ID" | tr -c 'A-Za-z0-9_-' '_')"
    if [ "$(cat "$cache" 2>/dev/null)" != "$state" ]; then
        printf '%s' "$state" >"$cache" 2>/dev/null
        "${HERDR_BIN_PATH:-herdr}" pane report-metadata "$HERDR_PANE_ID" \
            --source copilot-statusline --seq "$(date +%s%N)" \
            --token "aic=$aic" --token "elapsed=$elapsed" \
            >/dev/null 2>&1 </dev/null &
    fi
fi

dim=$'\e[2m'; reset=$'\e[0m'
green=$'\e[32m'; yellow=$'\e[33m'; red=$'\e[31m'; cyan=$'\e[36m'
sep=" ${dim}│${reset} "

parts=("$(date -d "@$last_active" +%H:%M 2>/dev/null || date -r "$last_active" +%H:%M)")

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

parts+=("$elapsed")

if [ "${added:-0}" != 0 ] || [ "${removed:-0}" != 0 ]; then
    parts+=("${green}+${added}${reset}/${red}-${removed}${reset}")
fi

out=""
for part in "${parts[@]}"; do
    [ -n "$out" ] && out+="$sep"
    out+="$part"
done
printf '%s\n' "$out"
