complete -c copilot-as -f -n __fish_is_first_arg -a '(path basename $HOME/dotfiles/files/copilot/souls/*/ | string match -v common) none'
complete -c copilot-as -n 'not __fish_is_first_arg' -w copilot
