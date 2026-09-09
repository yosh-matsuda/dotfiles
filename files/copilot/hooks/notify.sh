#!/bin/bash
input=$(cat)

title="Copilot CLI"
body=""
if command -v jq >/dev/null 2>&1; then
  t=$(printf '%s' "$input" | jq -r '.title // empty')
  body=$(printf '%s' "$input" | jq -r '.message // empty')
  [ -n "$t" ] && title="$t"
fi
[ -z "$body" ] && body="通知"

# OSC 777 は ; 区切りなので本文から除去。cut はバイト単位で日本語を壊すため使わない
sanitize() { printf '%s' "$1" | tr -d ';\n\r\033'; }
title=$(sanitize "$title"); title="${title:0:60}"
body=$(sanitize "$body"); body="${body:0:160}"

if [ -n "$TMUX" ]; then
  printf '\033Ptmux;\033\033]777;notify;%s;%s\033\033\134\033\134' "$title" "$body" > /dev/tty
else
  printf '\033]777;notify;%s;%s\033\134' "$title" "$body" > /dev/tty
fi

