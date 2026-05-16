# fisher bootstrap installation
if not functions -q fisher
    set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
    curl https://git.io/fisher --create-dirs -sLo $XDG_CONFIG_HOME/fish/functions/fisher.fish
    fish -c fisher
end

# common aliases
alias sudo='sudo --preserve-env=PATH'
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
set -g __dotfiles_repo $HOME/dotfiles

function __dotfiles_repo_available
  if not type -q git
    return 1
  end

  if not test -d $__dotfiles_repo/.git
    return 1
  end
end

function __dotfiles_git_status
  command git -C $__dotfiles_repo status --porcelain=v2 --branch 2>/dev/null
end

function __dotfiles_classify_status --argument-names git_status
  if test -z "$git_status"
    return 1
  end

  if string match -qr '^u ' -- $git_status
    printf '%s' 'dotfiles conflict'
    return
  end

  if string match -qr '^(1|2|\?|!) ' -- $git_status
    printf '%s' 'dotfiles dirty'
    return
  end

  if string match -qr '^# branch\.ab \+0 -[1-9][0-9]*$' -- $git_status
    printf '%s' 'dotfiles behind'
    return
  end

  if string match -qr '^# branch\.ab \+[1-9][0-9]* -[0-9]+$' -- $git_status
    printf '%s' 'dotfiles unpushed'
  end
end

function __dotfiles_prompt_status
  __dotfiles_repo_available; or return

  __dotfiles_classify_status (__dotfiles_git_status)
end

function __dotfiles_pull_on_startup
  if not status --is-interactive
    return
  end

  __dotfiles_repo_available; or return

  # Skip auto-pull unless the worktree is clean and conflict-free.
  set -l git_status (__dotfiles_git_status)
  or return

  set -l dotfiles_status (__dotfiles_classify_status $git_status)
  if test "$dotfiles_status" = 'dotfiles conflict'
    return
  end

  if test "$dotfiles_status" = 'dotfiles dirty'
    return
  end

  # Skip repositories without a tracking upstream branch.
  if not command git -C $__dotfiles_repo rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1
    return
  end

  # Refresh remote refs before deciding whether a fast-forward is possible.
  command git -C $__dotfiles_repo fetch --quiet --prune >/dev/null 2>&1
  or return

  # Only pull when local is strictly behind upstream and not ahead.
  set -l dotfiles_status_after_fetch (__dotfiles_classify_status (__dotfiles_git_status))
  if test "$dotfiles_status_after_fetch" != 'dotfiles behind'
    return
  end

  # Fast-forward in the background so shell startup stays responsive.
  command git -C $__dotfiles_repo pull --ff-only --quiet >/dev/null 2>&1 &
  disown
end

__dotfiles_pull_on_startup

#
# fish-command-timer
#
set fish_command_timer_time_format "%Y/%m/%d %H:%M"
set fish_command_timer_min_cmd_duration 1000
