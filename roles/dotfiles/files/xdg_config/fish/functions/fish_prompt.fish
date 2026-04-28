function fish_prompt
	test $SSH_TTY
    and printf (set_color red)$USER(set_color brwhite)'@'(set_color yellow)(prompt_hostname)' '
    test $USER = 'root'
    and echo (set_color red)"#"

    # Main
    echo -n (set_color cyan)(prompt_pwd) (set_color red)'❯'(set_color yellow)'❯'(set_color green)'❯ '
end

function fish_prompt
  if [ $status -eq 0 ]
    set status_face (set_color green)"（๑╹‿╹)ﾉ"(set_color yellow)"✨" (set_color green)'⟫'(set_color yellow)'⟫'(set_color red)'⟫ '
  else
    set status_face  (set_color blue)"（;╹ロ╹)"(set_color yellow)"💬" (set_color green)'⟫'(set_color yellow)'⟫'(set_color red)'⟫ '
  end

  #set prompt '['(set_color yellow)(prompt_pwd)'|'(__terlar_git_prompt)']'
  #set prompt (set_color white)'['(set_color yellow)(prompt_hostname)(set_color white)']'
  echo $prompt $status_face(set_color white)
end

