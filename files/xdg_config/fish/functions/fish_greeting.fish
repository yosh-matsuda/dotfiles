function fish_greeting
    # message of the day
    for motd in /run/motd.dynamic /etc/motd
        if test -s "$motd"
            /bin/cat "$motd"
            break
        end
    end
end
