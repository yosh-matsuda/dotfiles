# fisher bootstrap installation
if not functions -q fisher
    set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
    curl https://git.io/fisher --create-dirs -sLo $XDG_CONFIG_HOME/fish/functions/fisher.fish
    fish -c fisher
end

# common aliases
alias sudo='sudo -E '
alias vi='vim'
alias cp='cp -i'
alias mv='mv -i'
alias rm='rm -i'
alias crontab='crontab -i'
alias diff='diff -u'

switch (uname)
  case Darwin
    alias ls='ls -althrG'
    if type -q ggrep
      alias grep='ggrep --color=auto'
    end
    function ipi
      ipconfig getifaddr en0 2>/dev/null; or ipconfig getifaddr en1 2>/dev/null
    end
  case '*'
    alias ls='ls -althr --color=auto'
    alias grep='grep --color=auto'
    alias ps='ps --sort=start_time'
    alias ipi='ip -f inet -o addr |cut -d\  -f 7 | cut -d/ -f 1'
end

alias less='less -IRS'
alias df='df -h'
alias du='du -h'
alias ipe='curl ipinfo.io/ip'
alias su='command sudo -iu'

if type -q bat; alias cat='bat'; end
if type -q eza; alias ls='eza -alh -s=time --color-scale --git'; end

# tmux
if [ -f ~/.local/bin/tmux.sh ]; alias tmux='~/.local/bin/tmux.sh'; end

#
# completions
#

# brew
if type -q brew
  if test -d (brew --prefix)"/share/fish/completions"
    set -gx fish_complete_path $fish_complete_path (brew --prefix)/share/fish/completions
  end
  if test -d (brew --prefix)"/share/fish/vendor_completions.d"
    set -gx fish_complete_path $fish_complete_path (brew --prefix)/share/fish/vendor_completions.d
  end
end

#
# variables
#
set -x FISH_RUNNING 1

#
# fish-command-timer
#
set fish_command_timer_time_format "%Y/%m/%d %H:%M"
set fish_command_timer_min_cmd_duration 1000
