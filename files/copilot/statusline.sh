#!/usr/bin/env bash
# Copilot CLI status line. Reads the session JSON on stdin and prints one line.
set -u

payload=$(cat)

IFS=$'\x1f' read -r cwd model pct dur_ms added removed session_id nano_aiu transcript session_name activity < <(
    jq -r '[
        (.cwd // ""),
        (.model.display_name // .model.id // "?"),
        (.context_window.current_context_used_percentage // .context_window.used_percentage // ""),
        (.cost.total_duration_ms // 0),
        (.cost.total_lines_added // 0),
        (.cost.total_lines_removed // 0),
        (.session_id // ""),
        (.ai_used.total_nano_aiu // 0),
        (.transcript_path // ""),
        (.session_name // "" | gsub("[\u0000-\u001f]"; " ")),
        ([.ai_used.total_nano_aiu, .cost.total_api_duration_ms, .context_window.total_tokens,
          .cost.total_lines_added, .cost.total_lines_removed] | tostring)
    ] | map(tostring) | join("\u001f")' <<<"$payload" 2>/dev/null
)

# The idle time counts from when Copilot last did work. statusLine.refreshInterval
# reruns this script while the session is idle, so that time is kept per session and
# moves only when the usage counters change.
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

[[ ${nano_aiu:-} =~ ^[0-9]+$ ]] || nano_aiu=0
dur_ms=${dur_ms:-0}
s=$(( ${dur_ms%.*} / 1000 ))
elapsed=$(printf '%d:%02d' $((s / 3600)) $(((s % 3600) / 60)))

# Background agents and shells, running tools, mode, and compactions come from the
# session log, which the helper reads incrementally.
bg_agents=0; bg_shells=0; tools=""; mode="interactive"; compactions=0
if [ -n "${transcript:-}" ] && [ -n "${session_id:-}" ]; then
    IFS=$'\x1f' read -r bg_agents bg_shells tools mode compactions < <(
        python3 "$HOME/dotfiles/files/scripts/copilot-session-activity.py" status "$transcript" "$session_id" 2>/dev/null
    )
fi
[[ ${bg_agents:-} =~ ^[0-9]+$ ]] || bg_agents=0
[[ ${bg_shells:-} =~ ^[0-9]+$ ]] || bg_shells=0
[[ ${compactions:-} =~ ^[0-9]+$ ]] || compactions=0
bg_total=$(( bg_agents + bg_shells ))

# Reports the session name to herdr as $copilot_session, "#" plus the name so that an
# unnamed session still reports a value; herdr-tab-names.mjs uses it to split the
# terminal title. The status line runs on every render, so a report is sent only when
# the name changes, in the background.
if [ "${HERDR_ENV:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
    state="${session_id:-} #${session_name:-}"
    cache="${XDG_RUNTIME_DIR:-/tmp}/herdr-copilot-session-$(printf '%s' "$HERDR_PANE_ID" | tr -c 'A-Za-z0-9_-' '_')"
    if [ "$(cat "$cache" 2>/dev/null)" != "$state" ]; then
        printf '%s' "$state" >"$cache" 2>/dev/null
        "${HERDR_BIN_PATH:-herdr}" pane report-metadata "$HERDR_PANE_ID" \
            --source copilot-statusline --seq "$(date +%s%N)" \
            --token "copilot_session=#${session_name:-}" \
            >/dev/null 2>&1 </dev/null &
    fi
fi

dim=$'\e[2m'; reset=$'\e[0m'
green=$'\e[32m'; yellow=$'\e[33m'; red=$'\e[31m'; cyan=$'\e[36m'; magenta=$'\e[35m'; orange=$'\e[38;5;208m'
sep=" ${dim}│${reset} "

parts=()

# Hidden while Copilot is working, then the time since it last did work.
idle=$(( (now - last_active) / 60 ))
if [ "$idle" -ge 1440 ]; then
    parts+=("idle $((idle / 1440))d")
elif [ "$idle" -ge 60 ]; then
    parts+=("idle $((idle / 60))h$(printf '%02d' $((idle % 60)))m")
elif [ "$idle" -ge 1 ]; then
    parts+=("idle ${idle}m")
fi

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

case "${mode:-interactive}" in
    plan) parts+=("${magenta}plan${reset}") ;;
    autopilot) parts+=("${yellow}autopilot${reset}") ;;
esac

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

[ -n "${tools:-}" ] && parts+=("${cyan}▶ ${tools}${reset}")

if [ "$bg_total" -gt 0 ]; then
    work=""
    [ "${bg_agents:-0}" -gt 0 ] && work="${bg_agents} agent$([ "$bg_agents" -gt 1 ] && echo s)"
    [ "${bg_shells:-0}" -gt 0 ] && work+="${work:+, }${bg_shells} shell$([ "$bg_shells" -gt 1 ] && echo s)"
    parts+=("${orange}⧗ ${work}${reset}")
fi

[ "${compactions:-0}" -gt 0 ] && parts+=("⟳ ${compactions}")

out=""
for part in "${parts[@]}"; do
    [ -n "$out" ] && out+="$sep"
    out+="$part"
done
printf '%s\n' "$out"
