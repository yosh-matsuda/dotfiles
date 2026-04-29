function fish_right_prompt --description '右側に pwd と git status を表示'
  set -l dotfiles_status (__dotfiles_prompt_status)
  if test -n "$dotfiles_status"
    switch $dotfiles_status
      case 'dotfiles conflict'
        set_color red
      case 'dotfiles dirty'
        set_color yellow
      case 'dotfiles unpushed'
        set_color blue
    end
    printf '[%s] ' "$dotfiles_status"
    set_color normal
  end
  prompt_hostname
  printf '%s' ':'
  prompt_pwd
  #__terlar_git_prompt
end

