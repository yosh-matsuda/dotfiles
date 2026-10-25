function copilot-as --description 'Start Copilot CLI as a persona in files/copilot/souls, or as itself with none'
    set -l souls $HOME/dotfiles/files/copilot/souls
    set -l names (path basename $souls/*/ | string match -v common)
    if test (count $argv) -eq 0; or not contains -- $argv[1] $names none
        echo "usage: copilot-as <persona> [copilot options...]" >&2
        echo "personas: $names none" >&2
        return 2
    end
    set -l soul $argv[1]
    set -e argv[1]
    if test $soul = none
        env -u COPILOT_CUSTOM_INSTRUCTIONS_DIRS copilot $argv
    else
        env COPILOT_CUSTOM_INSTRUCTIONS_DIRS=$souls/common,$souls/$soul copilot $argv
    end
end
