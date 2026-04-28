# common aliases
alias sudo='sudo -E '
alias vi='vim'
alias cp='cp -i'
alias mv='mv -i'
alias rm='rm -i'
alias crontab='crontab -i'
alias diff='diff -u'
alias less='less -IRS'
alias df='df -h'
alias du='du -h'
alias ipe='curl ipinfo.io/ip'
alias su='command sudo -iu'

if [[ "$OSTYPE" =~ "darwin" ]]; then
    # macOS
    alias ls='ls -althrG'
else
    alias ls='ls -althr --color=auto'
    alias grep='grep --color=auto'
    alias ps='ps --sort=start_time'
fi

if command -v ggrep >/dev/null 2>&1; then
    alias grep='ggrep --color=auto'
fi

if [[ "$OSTYPE" =~ "darwin" ]]; then
    ipi() {
        ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null
    }
else
    alias ipi="ip -f inet -o addr | cut -d' ' -f 7 | cut -d/ -f 1"
fi

if [ -f ~/.local/bin/tmux.sh ]; then
    alias tmux='~/.local/bin/tmux.sh'
fi
if type bat 2>/dev/null 1>/dev/null; then
    alias cat='bat'
fi
if type eza 2>/dev/null 1>/dev/null; then
    alias ls='eza -alh -s=time --color-scale --git'
fi
