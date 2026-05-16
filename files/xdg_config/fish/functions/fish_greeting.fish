function fish_greeting
    if test "$TERM_PROGRAM" = "vscode"
        return
    end

    # oh-my-logo
    if command -q npx
        set palettes grad-blue sunset dawn nebula mono ocean fire forest gold purple mint coral matrix
        set palette_index (random 1 (count $palettes))
        npx -y --silent oh-my-logo (hostname) $palettes[$palette_index] --filled --block-font tiny --letter-spacing 3
    end

    # message of the day
    if command -q fastfetch
        fastfetch
    else
        for motd in /run/motd.dynamic /etc/motd
            if test -s "$motd"
                /bin/cat "$motd"
                break
            end
        end
    end
end
