function copilot-soul --description 'Show or set the default Copilot CLI persona of this machine, or remove it with none'
    set -l souls $HOME/dotfiles/files/copilot/souls
    set -l link $HOME/.copilot/soul
    set -l names (path basename $souls/*/ | string match -v common)
    if test (count $argv) -eq 0
        if test -L $link
            path basename (readlink $link)
        else
            echo none
        end
        return 0
    end
    if test (count $argv) -gt 1; or not contains -- $argv[1] $names none
        echo "usage: copilot-soul [<persona> | none]" >&2
        echo "personas: $names none" >&2
        return 2
    end
    if test -e $link; and not test -L $link
        echo "copilot-soul: $link exists and is not a symlink; remove it first" >&2
        return 1
    end
    if test $argv[1] = none
        test -L $link; and command rm -f -- $link
    else
        command mkdir -p (path dirname $link); and command ln -sfn -- $souls/$argv[1] $link
    end
end
