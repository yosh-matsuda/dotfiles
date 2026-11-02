# The herdr plugin in files/herdr/code-remote needs the same logic without fish, so it lives there in bash.
function code-remote --description 'Open a directory or file in VS Code over WSL or a connected window, else print a clickable Remote link'
    bash $HOME/dotfiles/files/herdr/code-remote/code-remote.sh $argv
end
