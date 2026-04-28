function fish_right_prompt --description '右側に pwd と git status を表示'
  prompt_hostname
  echo ':'
  prompt_pwd
  #__terlar_git_prompt
end

