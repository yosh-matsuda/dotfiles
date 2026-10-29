# Export the variables in ~/.config/<dir>/*.env for each <dir> listed in
# ~/.config/dotfiles/env_dirs. The dotfiles role writes both from
# dotfiles_env_files in local.vars.yml.
set -l config_home (set -q XDG_CONFIG_HOME; and echo $XDG_CONFIG_HOME; or echo ~/.config)
set -l env_dirs_file $config_home/dotfiles/env_dirs

if test -r $env_dirs_file
    for dir in (string trim < $env_dirs_file | string match -rv '^(#|$)')
        for env_file in $config_home/$dir/*.env
            test -r $env_file; or continue

            while read -l line
                # Skip blank lines and comments.
                string match -qr '^\s*(#|$)' -- "$line"; and continue

                set -l pair (string split -m 1 = -- (string replace -r '^\s*export\s+' '' -- "$line"))
                test (count $pair) -eq 2; or continue

                set -l key (string trim -- "$pair[1]")
                string match -qr '^[A-Za-z_][A-Za-z0-9_]*$' -- "$key"; or continue

                set -l value (string trim -- "$pair[2]")
                if string match -qr '^(["\']).*\1$' -- "$value"
                    set value (string sub -s 2 -e -1 -- "$value")
                end

                set -gx $key "$value"
            end <$env_file
        end
    end
end
