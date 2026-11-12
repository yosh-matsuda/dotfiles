# dotfiles

Ansible-based dotfiles for my local development environment.

This repository applies shell settings, XDG config files, and CLI tools on Ubuntu, WSL, and macOS with Ansible, and sets up the Windows side of WSL with `winget configure`. It is meant to be re-run to keep the machine state consistent.

## What it sets up

On Ubuntu, WSL, and macOS, with the Ansible playbook:

-   dotfiles in the home directory
-   XDG config files
-   Homebrew packages and casks, including Copilot CLI
-   pipx packages
-   Docker on WSL
-   herdr and automatic startup in interactive SSH terminals
-   Pairfob for phone access to herdr on Ubuntu
-   fish and fisher
-   Copilot CLI settings, extensions, hooks, and personas

On Windows:

-   Windows applications, WSL, fonts, and key remapping, with `winget configure`
-   WezTerm and VS Code settings, and the SSH keys and config of WSL, copied from WSL by the `windows` role

## Getting started

### Bootstrap a new machine

[bootstrap.sh](bootstrap.sh) does the steps of [Manual setup](#manual-setup) on a new machine: it installs Git and Ansible with apt on Ubuntu, or Ansible with Homebrew on macOS, clones this repository into `~/dotfiles`, creates `local.hosts.yml` from the example when it is missing, installs the collection, and runs the playbook on the hosts of `local.hosts.yml` with `ansible_connection: local`. SSH hosts in `local.hosts.yml` are updated only by running the playbook by hand. `local.vars.yml` is optional and is left to you. Each step is skipped when it is already done.

```bash
$ bash -c "$(curl -fsSL https://raw.githubusercontent.com/yosh-matsuda/dotfiles/main/bootstrap.sh)"
```

On Windows, run [bootstrap.ps1](bootstrap.ps1) from a normal PowerShell:

```powershell
> irm https://raw.githubusercontent.com/yosh-matsuda/dotfiles/main/bootstrap.ps1 | iex
```

1.  `winget configure --enable` updates App Installer from Microsoft Store when it is the stub that a new Windows ships, whose `winget configure` fails with `Extended features are not enabled` and exit code `-1978335127` (`0x8A150069`). On a full App Installer it only reports that the features are enabled.
2.  `winget configure` applies [.config/configuration.winget](.config/configuration.winget). winget asks for elevation once for the resources marked `securityContext: elevated`.
3.  `wsl --install Ubuntu-26.04 --no-launch` installs the distribution unless it is registered. When Virtual Machine Platform was just enabled, this fails until Windows restarts; restart and run the script again.
4.  When the distribution has no default user yet, its shell opens once: enter a user name and a password at the prompts of Ubuntu, then run `exit` at the shell prompt. The distribution creates the user only in its first interactive shell. The script continues in the same window; closing it or pressing `Ctrl+C` stops the script, and running the one-liner again skips the user that already exists.
5.  `bootstrap.sh` runs in the distribution. It asks for the Linux password twice: for `sudo` before `apt-get`, and at `BECOME password:` of the playbook. WSL mounts `/mnt/c` with the uid of the default user when the distribution starts, so an instance that started before the user existed has it owned by root, and the playbook fails at `Copy WezTerm config` with `Operation not permitted`. The script restarts the distribution with `wsl --terminate` first when the owner of `/mnt/c` differs from the user.

Pick another distribution or branch with `& ([scriptblock]::Create((irm <URL>))) -Distro Ubuntu-24.04 -Branch <branch>`.

### Manual setup

-   Python 3
-   Ansible
-   sudo access
-   Git

Install the required Ansible collection before the first run:

```bash
$ ansible-galaxy collection install -r collections/requirements.yml
```

Copy the local example files and edit them for your environment. Both are Git-ignored; put local inventory entries and private variables only there.

```bash
$ cp local.hosts.yml.example local.hosts.yml
$ cp local.vars.yml.example local.vars.yml
```

Then run the playbook:

```bash
$ ansible-playbook site.yml --ask-become-pass
```

Ubuntu 26.04 ships sudo-rs as `sudo`, whose password prompt the Ansible sudo become plugin cannot detect. The first play in [site.yml](site.yml) checks each host for `/usr/bin/sudo.ws`, the original sudo, and uses it for become where it exists, so no `ANSIBLE_BECOME_EXE` is needed. Ad hoc `ansible -b` runs do not get this switch; add `-e ansible_become_exe=sudo.ws` for those hosts.

Main settings live under [files](files). Package lists and shared variables are defined in [group_vars/all.yml](group_vars/all.yml). Paths are preconfigured in `ansible.cfg`, so run the commands from the repository root.

Syntax check:

```bash
$ ansible-playbook site.yml --syntax-check
```

### API tokens

API tokens shared by several machines live in `local.vars.yml`, never in the repository. Copy that file to each machine by hand, for example with `scp`, and run the playbook there. `dotfiles_env_files` maps a directory under `~/.config` to file names, and each file name to variables; every variable becomes a `NAME=value` line of `~/.config/<dir>/<file>.env`:

```yaml
dotfiles_env_files:
  dirname:          # ~/.config/dirname/
    example:        # ~/.config/dirname/example.env
      EXAMPLE_API_TOKEN: xxxxxxxx
```

-   The playbook replaces the line that sets the same name, with or without `export`, and appends the variable when no line sets it. Other lines, and `.env` files that `local.vars.yml` does not name, are kept, so a variable set by hand on one machine stays.
-   A variable removed from `local.vars.yml` stays in the file; delete its line by hand.
-   Each directory gets mode `0700` and each file the playbook writes gets `0600`.
-   The playbook appends each directory to `~/.config/dotfiles/env_dirs`, one per line, relative to `~/.config`. A directory removed from `local.vars.yml` stays in the list; delete its line by hand. A directory added to the list by hand is read too.
-   [env_files.fish](files/xdg_config/fish/conf.d/env_files.fish) exports every `NAME=value` line of `~/.config/<dir>/*.env` for each directory in that list when fish starts. It skips blank lines and `#` comments, accepts a leading `export`, and strips one pair of matching quotes around the value. Other shells do not read the files.

## Windows

The Windows side comes from two places. [.config/configuration.winget](.config/configuration.winget) declares applications, Windows features, and key remapping, and `winget configure` applies it, from `bootstrap.ps1` or by hand. The `windows` role of the playbook copies application settings from WSL into the Windows user profile.

### Applications and features

[.config/configuration.winget](.config/configuration.winget) declares Virtual Machine Platform, WSL, Git, VS Code, PowerShell 7, Coreutils for Windows, the Ditto clipboard manager, uv, the Visual C++ runtimes, the WezTerm nightly build, the UDEV Gothic NF fonts that [wezterm.lua](files/windows/wezterm/wezterm.lua) uses, and the key remapping in [Keyboard](#keyboard). Check the machine against it without changing anything:

```powershell
> winget configure test -f .config\configuration.winget
```

-   Packages with `useLatest: true` are upgraded to the latest version whenever the configuration is applied, so rerunning `bootstrap.ps1` or `winget configure` works like `winget upgrade` for them, and `winget configure test` reports an outdated package. WSL is left out, because upgrading it restarts the WSL service and stops the running distributions; update it with `wsl --update`. VS Code is left out, because it updates itself.
-   Virtual Machine Platform is enabled by a script with `Enable-WindowsOptionalFeature`. winget installs DSC from Microsoft Store, and the `Microsoft.Windows/OptionalFeatureList` resource of that DSC stops with `This resource currently is not supported when installed via Appx`. `EnablePending` counts as enabled, because the feature takes effect after the restart that `bootstrap.ps1` asks for.
-   WezTerm and the fonts are installed by `Microsoft.DSC.Transitional/WindowsPowerShellScript` resources. The winget package `wez.wezterm.nightly` pins the SHA256 of an installer that the `nightly` tag replaces, so its install fails on a hash mismatch, and `wez.wezterm` is the 20240203 release. No winget package provides UDEV Gothic.
-   The WezTerm test passes for any installed WezTerm, so a rerun never updates it. Run the nightly installer again to update.
-   Ditto starts at sign-in from the `Ditto` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which the `DittoStartup` unit writes for the user that runs `winget configure`. Turning off `Run on Windows startup` in the Ditto options deletes the value, and the next apply writes it again. The silent install starts Ditto from the elevated installer, so the first Ditto runs elevated until sign-out.
-   `Alt` + `Menu` opens Ditto. The `DittoHotKey` unit writes `DittoHotKey` under `HKCU\Software\Ditto`, and the next apply writes it again after a change in the Ditto options. Ditto reads it only at startup, so exit Ditto from the tray icon and start it again after the value changes.
-   winget 1.29 `winget configure validate` warns that no module is specified and that the units are not public, and exits with 1, for this file and for the files that `winget configure export` writes alike. `winget configure test` and `winget configure` are not affected.

### Arm64

-   The same file serves x64 and Arm64 machines. On Arm64, winget picks the Arm64 installer of each package and falls back to x64 under emulation. WezTerm ships only an x64 build and runs emulated; the x64 Visual C++ runtime it needs installs on Arm64 too and carries the Arm64 binaries as well. uv for Arm64 depends on `Microsoft.VCRedist.2015+.arm64`, a separate package, so the elevated `VCRedistArm64` unit installs it before uv, which would otherwise raise a second elevation prompt. winget configure has no condition on a unit, so `VCRedistArm64` is a script that reports the desired state on other architectures and runs the `Microsoft.WinGet/Package` resource through `dsc.exe` on Arm64. Ubuntu, the Homebrew packages, Docker, and Pairfob all provide Arm64 builds for the playbook in WSL.
-   uv runs natively on Arm64 and, since uv 0.13.0, prefers native Arm64 Python. Wheels follow the architecture of the interpreter, and many packages publish `win_amd64` wheels without `win_arm64` ones, such as `torch`, `pyarrow`, and `grpcio` on 2026-10-26. To use x86_64 Python, which runs emulated, set `UV_PYTHON_ARCH=x86_64` yourself, or request it per environment: `uv venv --python cpython-3.14-windows-x86_64`.

### Keyboard

[.config/configuration.winget](.config/configuration.winget) remaps keys on Windows, for the Japanese (JIS) layout:

| Keys | Result | Unit |
| --- | --- | --- |
| `CapsLock` (英数) | Left `Ctrl` (original left `Ctrl` unchanged) | `ScancodeMap` |
| `半角/全角`, `変換` | swapped | `ScancodeMap` |
| `無変換` + `i` `j` `k` `l` | `↑` `←` `↓` `→` | kanata |
| `無変換` + `u` `o` | `PageUp` `PageDown` | kanata |
| `無変換` + `a` `;` | `Home` `End` | kanata |
| `無変換` + `h` `d` | `Backspace` `Delete` | kanata |
| `無変換` + `Space` | `Enter` | kanata |
| `無変換` + `Tab` | Toggle CapsLock (`Shift` + `CapsLock` on JIS) | kanata |

-   The remaps are one key to one key, so the registry value `Scancode Map` holds them. The keyboard driver rewrites the scancodes before any application sees them, so they hold in elevated windows, at sign-in, and without kanata. Left `Ctrl` stays unchanged so mouse macros that send left Ctrl retain their shortcuts. Both the original left `Ctrl` and the key labeled `CapsLock` send Ctrl; use `無変換` + `Tab` to toggle CapsLock instead. Windows reads the value at startup: restart after it changes. The unit replaces the whole value, including entries written by other tools.
-   A `無変換` layer needs a resident program. [kanata](https://github.com/jtroo/kanata) is a key remapper that runs natively on x64 and Arm64. Its winIOv2 build identifies keys by scancode, so `;` is the physical key right of `l` on JIS as well. `無変換` sends nothing by itself: a tap that sends `無変換` would have to tell a tap from a hold by timing, which misfires when typing fast. Keys outside `defsrc` never pass through kanata.
-   kanata runs elevated, or its layer would not reach elevated windows, so its executable and config live where only administrators can change them. `KanataPackage` installs the GUI and the console build of kanata into `%ProgramFiles%\kanata` from the GitHub release, checks their SHA256, resets their owner to Administrators and their ACLs to those inherited from Program Files, and its test fails while any account other than SYSTEM, Administrators, and TrustedInstaller can write to them. A writable executable would let an unelevated process replace what runs elevated. `KanataConfig` writes the config inline in the configuration file to `%ProgramFiles%\dotfiles\kanata.kbd`, and `KanataTask` registers the scheduled task `\dotfiles\kanata` that starts it with the highest privileges at sign-in, without a UAC prompt. The task runs at normal priority with no time limit, unlike the defaults of below normal and 72 hours. Its trigger repeats every minute while you are signed in, and a repetition is skipped while kanata runs, so kanata comes back within a minute after it exits for any reason, a crash or the emergency exit alike. The repetition comes from a time trigger in the past: the restart-on-failure setting of a task does not react to a process that exits, and the repetition of a logon trigger starts only at the next sign-in, not when the configuration registers and starts the task. A test task whose process exited with code 1 was never restarted by the former, and kanata stayed stopped with the latter. Rerunning the configuration restarts kanata when it is not running or started before the config was written.
-   kanata is pinned to `v1.13.0-prerelease-1`, whose binaries report themselves as `v1.13.0-prerelease-2`. v1.12.0, the latest release and the version in winget, compares the keys it holds with the Windows key state through US virtual-key codes. On JIS the key right of `l` is `VK_OEM_PLUS` (`0xBB`), not `VK_OEM_1` (`0xBA`), so every `;` raised `Unexpected keycode is pressed in kanata but not in Windows` as a notification, and v1.12.0 has no option to stop the check. The prerelease adds `windows-sync-keystates none`, which the config sets. The other keys of the layer map to the same virtual-key codes on JIS and US.
-   The release publishes no checksums, so `KanataPackage` pins the SHA256 of the files downloaded on 2026-10-27. To update kanata, change `version` and the hashes of `KanataPackage` and apply the configuration; the unit stops kanata first, because a running kanata locks its executable. The unit also uninstalls `jtroo.kanata_gui`, which an earlier version of the configuration installed with winget.
-   To change the layer, edit the `content` of `KanataConfig` and apply the configuration. Validate a config without hooking the keyboard with the console build: `& "$env:ProgramFiles\kanata\kanata_windows_tty_winIOv2_x64.exe" --cfg <file> --check`, or `_arm64.exe` on Arm64. Bump `revision` of `KanataTask` when its task definition changes.
-   kanata does not reach the secure desktop, such as UAC prompts and the lock screen, where only the `Scancode Map` remaps apply and `無変換` + `Tab` is unavailable. `LCtrl` + `Space` + `Esc` stops kanata in an emergency, and the task starts it again within a minute; either the original left `Ctrl` or the key labeled `CapsLock` works as `LCtrl`. To keep kanata stopped, run `Disable-ScheduledTask -TaskPath '\dotfiles\' -TaskName kanata` in an elevated PowerShell before stopping it; applying the configuration registers the task again, enabled.

### Application settings

On WSL, the `windows` role writes into the Windows user profile through `/mnt/c`. Windows applications cannot read WSL symlinks, so the files are copied, and changes must be made in this repository and applied by running the playbook.

-   WezTerm: [files/windows/wezterm/wezterm.lua](files/windows/wezterm/wezterm.lua) is copied to `%USERPROFILE%\.config\wezterm\wezterm.lua` and replaces it entirely. Values that differ per machine go into a generated `machine.lua` next to it; the default domain is the WSL distribution that runs the playbook. Edits made directly on the Windows side are overwritten.
-   WezTerm and GPU loss: when the OpenGL context is lost, for example when an external GPU is unplugged, WezTerm closes the GUI window but never recreates it, so the panes and their WSL shells keep running unseen. A herdr client left in such a process repeats every notification. Every 5 seconds the config checks for mux windows in the active workspace while no GUI window exists; after two hits in a row it starts a new `wezterm-gui.exe start --always-new-process` and exits, which also ends the old WSL shells. Rendering cannot simply be pinned to the integrated GPU: the per-app Windows graphics preference does not reach WGL here, the ANGLE path (`prefer_egl`) follows it but loses window transparency, and `front_end = 'Software'` still loads the system `opengl32.dll` because `wezterm-gui.exe` imports it statically.
-   VS Code: only the keys in [files/windows/vscode](files/windows/vscode) are merged into `%APPDATA%\Code\User`; everything else stays with Settings Sync. When that directory does not exist, the merge is skipped with a message. Settings are overwritten key by key, and keybindings are appended when missing. The files are JSONC, so [files/scripts/vscode-settings-merge.mjs](files/scripts/vscode-settings-merge.mjs) edits them with `jsonc-parser`, the library VS Code itself uses, which keeps comments and formatting. The role installs it with `npm ci` into `files/scripts/node_modules` when it is missing.
-   SSH: `~/.ssh` of WSL is the source, and the files directly in it are copied to `%USERPROFILE%\.ssh`, so that Windows applications such as VS Code Remote - SSH use the same keys and `ssh_config`. `known_hosts`, `known_hosts.*`, and `authorized_keys` stay separate on each side. Files that exist only on the Windows side are left as they are, and a key deleted in WSL stays on Windows until you delete it there. Keep `~/.ssh/config` valid for the OpenSSH of Windows: write paths as `~/.ssh/...`, and avoid options that Windows does not support, such as `ControlMaster`. WSL cannot use the Windows directory directly: `/mnt/c` is mounted without `metadata`, so the files appear with mode 777, and OpenSSH refuses such private keys and config. When `%USERPROFILE%\.ssh` is a symlink into a synced folder such as OneDrive, the copy goes there, and the last WSL that runs the playbook wins for a file name that differs between machines.

## Terminal

### herdr

-   herdr is installed with Homebrew, and its self-update is disabled for Homebrew installs. Detach, run `brew update && brew upgrade herdr`, then run `herdr` again to reconnect with the updated client. The running server keeps its old version; `herdr status` reports `update.restart_needed`, and only then is `herdr server stop` required.
-   Interactive SSH terminals start herdr automatically, except inside VS Code and herdr. Set `DOTFILES_NO_HERDR=1` to opt out, or use `ssh -t HOST 'bash --noprofile --norc -i'` for a recovery shell.
-   `Ctrl+b q` detaches the client and leaves the server and its panes running. herdr is started without `exec`, so detaching returns to the login shell instead of closing the SSH session, which is what the update flow above needs.
-   Panes inherit the environment of the long-lived `herdr server` process, so shell startup must not depend on inherited variables. A server auto-started by `herdr --remote` or a saved machine runs from a non-login SSH command and lacks `PATH` from `~/.profile`, so `[terminal] shell_mode = "login"` makes each pane run `~/.profile` itself. Pane commands ignore `shell_mode`, so the VS Code shortcut loads `~/.profile` explicitly before invoking `code` or the VS Code remote CLI. The shortcut, the fish function `code-remote`, and the [file link](#file-links) plugin all run [files/herdr/code-remote/code-remote.sh](files/herdr/code-remote/code-remote.sh), which needs bash but not fish. herdr takes custom commands from the config of the server that runs the pane, so the script is in the same checkout wherever the shortcut exists. On WSL, a server that Pairfob starts through systemd lacks `WSL_DISTRO_NAME` and the Windows `PATH`, which `code` needs, so `~/.profile` restores both when `WSL_DISTRO_NAME` is unset. Interactive bash switches to fish based on its parent process, which keeps herdr panes on fish no matter where the server was started from.
-   Apply config changes with `herdr server reload-config`.
-   Only [files/herdr/config.toml](files/herdr/config.toml) and the [agent detection overrides](#agent-state) are managed. Do not commit session snapshots, logs, sockets, or other runtime state from `~/.config/herdr`.
-   Existing tmux installations and configuration are left untouched and unmanaged.

### Pairfob

[Pairfob](https://github.com/arronKler/pairfob) lets a phone browser watch and drive the herdr agents of a host. Each host dials out to the relay at `pairfob.com`, so it needs no inbound port or VPN, and the session is end-to-end encrypted. Every Ubuntu host that gets herdr from `brew_packages` gets Pairfob as well, including WSL. A host that is asleep or offline stays on the phone's list until it is back. Each host keeps its own identity, so the phone pairs with each one and switches between them. macOS hosts are skipped, because the role relies on `loginctl` and a systemd drop-in.

-   The role runs after `prerequisite` and `brew` in [site.yml](site.yml): it downloads into `~/tmp` and fails when the Homebrew herdr is missing.
-   The role installs the binary into `~/.local/bin` with the official installer, which also enrolls the host and installs the `pairfob.service` user service, and adds the Pairfob herdr plugin for its action menu. Later runs call `pairfob update` only when the binary differs from the latest release.
-   The installer runs with `--no-install-herdr` and `HERDR_BIN` pointing at the Homebrew herdr. Without a herdr on `PATH` it would download a second one into `~/.local/bin`, whose default server would split the sessions.
-   `loginctl enable-linger` keeps the user service manager running after the last logout. Without it, Pairfob stops when the last SSH session ends, while the herdr server and its agents keep running unseen.
-   The installer rewrites `pairfob.service` and drops any variable added to it, so additions go to `~/.config/systemd/user/pairfob.service.d/dotfiles.conf`. It pins `HERDR_BIN`, because the service `PATH` lacks Homebrew. Push notifications need no setting: Pairfob sends them by default.
-   When no herdr server is running, Pairfob starts one with `systemd-run --user` in its own unit, so restarting or updating Pairfob leaves the agents alone.

Pairing needs the phone, so it is left to a shell on the host: run `pairfob pair`, open `https://pairfob.com/pair` on the phone, and scan the code. The **Pairfob: Pair a device** action in herdr does the same. For a second host, open **Settings → Switch computer → Add a computer** on the phone. Turn notifications on per host under **Settings → Notifications**. `pairfob doctor` diagnoses a host without changing anything.

### Tab names

Interactive fish shells inside herdr name numbered tabs after the foreground command via [files/scripts/herdr-tab-names.mjs](files/scripts/herdr-tab-names.mjs). For Copilot CLI, the label is the session name; a session without a name is labeled `copilot`. Manually renamed tabs are left alone.

Copilot CLI titles the terminal `<session name> - <status> - GitHub Copilot`, where the status is the intent the agent reports while it works, or `Waiting for background agents` or `Waiting for background shells` when a turn ends with background work still running. The Copilot status line reports the session name to the pane as the token `$copilot_session`, prefixed with `#` so that an unnamed session still reports a value, and the script uses it to split the title even when the name contains ` - `. Until that name arrives, or while the title still shows an older name, the tab keeps its label, because an intent alone reads the same as a session name; the tab name never takes the status. The status goes to the sidebar on the row under the tab, prefixed with `›` to set it apart from the session name above it. The script reports it as herdr's state labels, one for each state, and the row shows the `state_text` token, so herdr picks the label of the current state. Waiting for background work shows in any state; otherwise the intent shows while the agent works, or `Working…` before it reports one, because the title keeps the last intent after the turn, and the other herdr states read `Waiting for input`, `Done`, or `Idle`. The row hides herdr's own state words, which other agents and the unknown state show. The session name is bold and white, `#f8f8f2`, the text color of the Dracula theme that the config selects. The status is fainter: herdr colors take no alpha, so rules on the label text give each state the color of its state icon mixed 60% with the Dracula background. herdr shows a session that waits for background work only as working, so this row is what tells it apart: its status takes orange, the Dracula peach mixed the same way.

One worker per herdr server holds a lock, so a new fish shell does not replace a running worker. To pick up updates, kill the PID in `~/.local/state/herdr-tab-names/*/worker.pid` and open a new fish shell inside herdr.

### Agent state

herdr decides whether Copilot is working, blocked, or idle from rules in a detection manifest that it matches against the bottom of the pane; [files/scripts/herdr-tab-names.mjs](files/scripts/herdr-tab-names.mjs) only chooses the words for each state. herdr fetches the manifests from herdr.dev, and a file in `~/.config/herdr/agent-detection` replaces the manifest of its agent. The `dotfiles` role links [files/herdr/agent-detection](files/herdr/agent-detection) there and reloads the overrides with `herdr server reload-agent-manifests`. A running server reads the files only at startup or on that reload, so run it by hand after `git pull` changes them.

-   [copilot.toml](files/herdr/agent-detection/copilot.toml) is herdr's Copilot manifest `2026.08.29.1` with one rule changed. The published rule looks for `esc interrupt` and the other cancel hints anywhere on the screen, so a reply or a draft prompt that quotes one keeps an idle session working. The override reads only the bottom four non-empty lines, which hold the activity row of Copilot's footer, and skips the rows of the input box, which start with `┃`.
-   Until herdr settles [herdrdev/herdr#5799](https://github.com/herdrdev/herdr/issues/5799), the override also adds a rule for `ctrl+c interrupt`, which Copilot CLI 1.0.107 shows in the same row instead of `esc esc interrupt`. No published rule matches it, so a working Copilot falls back to idle without it. Revert the commit that added it once herdr publishes a manifest that covers it.
-   An override wins over every remote update. `herdr server agent-manifests` marks the agent as `local override` and lists the published version next to it; remove the override once herdr publishes a newer one that settles the change.
-   `herdr agent explain --file <screen.txt> --agent copilot` evaluates a saved screen, such as the output of `herdr pane read`, against the manifest files on disk without the server, so it shows the effect of an edit before the reload.

### File links

`Ctrl`+click on a file link that Copilot CLI prints opens the file in VS Code through `code-remote.sh`: on WSL with `code`, on an SSH host in a VS Code window that is connected to it. Without such a window, an overlay pane shows the `vscode://` link, which `Ctrl`+click opens in VS Code on Windows. The pane closes when VS Code takes the focus from WezTerm, or on any key.

-   Copilot CLI renders a Markdown link as an OSC 8 hyperlink whose target is the link target as written. [files/copilot/copilot-instructions.md](files/copilot/copilot-instructions.md) asks the agent to link files with absolute paths, because the agent writes paths in code spans otherwise, and those are not links.
-   herdr opens only `http(s)` links itself, so the herdr plugin [files/herdr/code-remote](files/herdr/code-remote) registers a link handler for `file:` URLs and targets without a scheme. The plugin action runs on the server that owns the pane, which is the host that has the file. It percent-decodes the target, because Copilot CLI encodes it with `encodeURI`, resolves a relative target against the pane's directory, and takes a line from `:LINE[:COLUMN]` or `#LLINE`. A link to a directory opens the root of the git working tree that holds it, because Peacock's `surpriseMeOnStartup` in VS Code writes `.vscode/settings.json` into every folder that opens as a workspace. Neither the `code` CLI nor a `vscode://` URI can select a folder in the explorer, so the same window also opens a file of the directory, a README first, and `explorer.autoReveal` expands the explorer to it; the `vscode://` link that shows without a connected window opens the root alone. A directory outside a git working tree raises a herdr notification instead. A target that does not exist raises a herdr notification. The plugin directory holds everything it runs, so it needs only bash and python3 on the host, not fish or the rest of this repository.
-   herdr finds links in plain text only for `http(s)`, so a path that appears as plain text, such as a path in a code span, is not a link.
-   The `dotfiles` role links the plugin on Ubuntu hosts that have the Homebrew herdr. Plugin commands run with the server's environment, so the action loads `~/.profile` itself, like the VS Code shortcut. Check the result of a click with `herdr plugin log list`.

### Web links

`Ctrl`+click on an `http(s)` link opens it in the default browser on Windows, where WezTerm runs. This works for a Markdown link that shows only its label, which `Shift+Ctrl`+click cannot open.

-   herdr opens a clicked link with `xdg-open` on the host that runs its client, WSL or an SSH host, which has no browser of its own. The `dotfiles` role links [files/local_bin/xdg-open](files/local_bin/xdg-open) into `~/.local/bin`, which comes first on `PATH`. When `TERM_PROGRAM` is `WezTerm` and the argument is an `http(s)` URL, it writes the URL to `/dev/tty` as the user var `dotfiles_open_url`, and the `user-var-changed` handler in [files/windows/wezterm/wezterm.lua](files/windows/wezterm/wezterm.lua) opens it with `wezterm.open_with`. Otherwise it runs the next `xdg-open` on `PATH`.
-   herdr starts `xdg-open` without a new session, so `/dev/tty` is the terminal of the herdr client and reaches WezTerm directly. herdr panes lack `TERM_PROGRAM` and herdr drops OSC 1337 from them, so a program in a pane, such as `gh browse`, still uses the system `xdg-open`.
-   `code-remote` prints its `vscode://` URI as text, linked to `https://vscode.dev/redirect?url=` followed by the URI, an `https` link that herdr opens on `Ctrl`+click. `Shift+Ctrl`+click lets WezTerm open the text itself. The file link plugin shows the link in an overlay pane, not a popup, because a herdr popup takes every mouse event itself and herdr never handles a `Ctrl`+click in it. herdr does not pass the click to the pane either, so [show-link.sh](files/herdr/code-remote/show-link.sh) turns on focus reporting and closes the pane on the focus-out report that herdr forwards when WezTerm loses the focus to VS Code.
-   Any output that reaches WezTerm outside herdr, such as `cat` of a file in a plain SSH shell, can set the same user var and open an `http(s)` URL in the browser or a `vscode://` URI in VS Code. The handler opens nothing else.
-   herdr reports a failure to open a link only in `~/.config/herdr/herdr-client.log` (`failed to open pane URL`).
-   WezTerm turns the mouse pointer into a hand only over a URL that it finds in the text on the screen. herdr does not pass the target of a labeled link to WezTerm, so the pointer stays an arrow over such a link, although `Ctrl`+click opens it.

### Notifications

herdr delivers agent notifications through the outer terminal (`[ui.toast] delivery = "terminal"`), for both finished and needs-attention events.

Detection depends on `TERM_PROGRAM`, which SSH does not forward. The login profile mirrors it into `LC_TERM_PROGRAM` and restores it on the far side. WezTerm adds `TERM_PROGRAM` to `WSLENV` itself when it starts a WSL domain, so no Windows environment variable is needed.

`TERM_PROGRAM` is intentionally absent inside panes; only the attached client matters. Verify with `herdr notification show test`.

herdr keeps one agent state per pane and infers it from the visible screen, so the background sessions of a Copilot process never notify. `files/copilot/hooks/session-notify.sh` closes that gap: it runs on `Stop` and pushes its own toast through the socket API. Its text is `<directory>: <last reply>`, read from the transcript the hook is handed, instead of the generic `copilot finished: <workspace>` that herdr emits, so the visible session can produce two toasts for one event.

`Notification` is deliberately not registered. It stays silent in `-p` mode but fires interactively for background shell completions, so it announces every `Run command` that finishes. `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SubagentStop` and `SessionEnd` also fire; `Stop` is raised once per turn, not once per tool call.

Subagents raise `Stop` too, which would notify in the middle of a turn. They report their parent's `transcript_path` under their own `session_id`, and the hook drops the event on that mismatch.

Copilot flushes the transcript after the hook has started, so the reply that just ended the turn is often missing or half written. Reading it straight away yields the previous message and the toast looks like it fired mid-turn; the hook therefore retries for two seconds until a reply newer than the `Stop` timestamp appears.

`[ui.toast] delivery` must stay `terminal`. `off` also drops `notification.show` on the client side, which would silence the hook as well.

herdr raises its own `copilot finished` toast from screen detection, which duplicates the hook whenever the outer terminal is unfocused. There is no per-event switch, so `delay_seconds` is parked at its maximum instead: state toasts wait an hour and are replaced as soon as the pane changes state, while `notification.show` from the hook ignores the delay entirely. A session left untouched for a full hour can still produce one late toast.

Copilot CLI can raise OS notifications itself (`notifications`, off by default). Leave it off; herdr and the hook already cover it.

References: [configuration](https://herdr.dev/docs/configuration/), [session state](https://herdr.dev/docs/session-state/), [integrations](https://herdr.dev/docs/integrations/).

### Copy and paste

One set of gestures holds in the VS Code integrated terminal and in WezTerm + herdr, for fish and for Copilot CLI alike:

| Action | Gesture | Exception |
| --- | --- | --- |
| Copy | Drag with the mouse; the text is copied when the button is released | Copilot keeps the copied text highlighted |
| Copy a word or a line | Double-click or triple-click; copied on release like a drag | herdr documents double-click only |
| Paste | `Ctrl+V` | |
| Copy or paste with the right button | Right-click copies and clears the selection if there is one, and pastes otherwise | Right after a drag the selection is still there, so it copies again; click once first or use `Ctrl+V`. In herdr, right-click opens the pane menu, and `Shift`+right-click pastes through the outer terminal |
| Open a link | `Ctrl`+click | In herdr, `Ctrl`+click opens `http(s)` links in the Windows browser (see [Web links](#web-links)), and file links in VS Code (see [File links](#file-links)). `Shift+Ctrl`+click lets the outer terminal open a URL that is visible as text; since herdr 0.9.4, herdr no longer passes OSC 8 hyperlinks to the outer terminal while `ui.mouse_capture` is on, so a labeled link does not open this way. `code-remote` prints its `vscode://` URI as text for this reason, and links it through vscode.dev for `Ctrl`+click |
| Interrupt | `Ctrl+C`, which never copies; fish clears the line or interrupts the command, Copilot stops the turn | In Copilot, `Ctrl+C` copies again while a highlight remains, and cancels the `ask_user` question even with a selection; press `Esc` twice instead |
| Select in the outer terminal | `Shift`+drag, which bypasses herdr and Copilot | In herdr the selection includes the sidebar and pane borders |
| Block selection | `Alt`+drag | In herdr, `Shift+Alt`+drag |

Drag-to-copy is the only copy gesture that every layer can share. herdr can copy a kept selection only on `Ctrl+C` (or `Cmd+C`), so [files/herdr/config.toml](files/herdr/config.toml) pins `copy_on_select = true`; with `false`, herdr would take `Ctrl+C` as copy while a selection exists. Copilot gets `"copyOnSelect": true` for the same reason. Pressing `Esc` twice within half a second stops a Copilot turn regardless of the highlight; the first press only shows a hint. A click outside the highlight clears it.

The outer terminals run on Windows and are configured as described in [Application settings](#application-settings):

-   VS Code: `"terminal.integrated.copyOnSelection": true`, and the Windows default `Ctrl+C` copy is removed in `keybindings.json`. The Windows default `terminal.integrated.rightClickBehavior` is already `copyPaste`.
-   WezTerm: copies on every left-button release, including double-click, triple-click and `Alt` block selection, and trims the trailing spaces that block selection pads each line with. Right-click copies and clears the selection or pastes, and link opening moves to `Ctrl`+click with the `Ctrl` press bound to nothing so it does not reach the application. `Ctrl+V` pastes, and `Ctrl+C` and `Alt` keys reach the application, which means the default `Alt+Enter` full-screen toggle is disabled. `Ctrl+Shift+C` copies only a non-empty selection; the default `CopyTo` has no such check and can overwrite what herdr copied with an empty string.

## Copilot CLI

### Installation

The `brew` role installs Copilot CLI as the Homebrew cask `copilot-cli`. The playbook only installs it; updates are left to Copilot CLI. The current standalone CLI writes updates beside its executable, so its installation directory must be writable. On Linux servers with a shared `linuxbrew` installation, the role grants all users write access to existing files under `/home/linuxbrew/.linuxbrew/Caskroom/copilot-cli` and sets default ACLs on its directories for new files. Every local user is trusted to modify the CLI that other users run. The role reapplies these permissions after cask installation; if Homebrew recreates the directory outside the playbook, rerun the role. WSL uses a user-owned Homebrew installation and does not need these ACLs. Homebrew's recorded cask version may differ from the self-updated CLI version. The cask is marked `auto_updates`, which `brew upgrade` skips unless `--greedy` is given. fish puts `~/.local/bin` before Homebrew in `PATH`, so a copy from the install script in `~/.local/bin/copilot` keeps running there; delete it after moving a machine to Homebrew.

### Settings

`~/.copilot/settings.json` is merged, not symlinked, because Copilot CLI rewrites the file atomically. The merge is one way: keys tracked in `files/copilot/settings.json` are restored on every run, and local-only keys such as the `hooks` block are preserved. To keep a local change everywhere, copy it into `files/copilot/settings.json`.

The playbook reports local-only keys after the Copilot tasks. Check by hand with:

```bash
$ python3 files/scripts/copilot-settings-drift.py
```

`~/.copilot/hooks` is a symlink into this repository, so `herdr integration install copilot` writes into the working tree. Expect `files/copilot/hooks/herdr-agent-state.sh` to change when herdr updates.

### Session usage

`statusLine.refreshInterval` reruns the Copilot status line [files/copilot/statusline.sh](files/copilot/statusline.sh) while a session is idle, and the status line starts with the time since Copilot last did work, such as `idle 12m`, because the script keeps that time per session in `$XDG_RUNTIME_DIR` and moves it only when the usage counters change. The tab bar shows the account's AI credits for the current billing cycle from [files/scripts/copilot-cycle-aic.py](files/scripts/copilot-cycle-aic.py), which calls GitHub's internal `/copilot_internal/user` API with Copilot CLI's token every five minutes. The count covers every Copilot surface and machine; the entry disappears when the token or the API is unavailable.

herdr infers Copilot's state from the screen, so a session whose turn ended while background agents or shells still run looks done. [files/scripts/copilot-session-activity.py](files/scripts/copilot-session-activity.py) reads the session's `events.jsonl` incrementally and counts that background work; shells started with `detach` are services and are not counted. The status line shows the counts with the running tools, the plan or autopilot mode, and the number of compactions.

### Forking into a herdr tab

`/fork-tab [name]` forks the current Copilot session and opens the fork in a new herdr tab of the same workspace, with `copilot --resume=<id>`. Unlike `/fork`, the original tab stays on the original session, so each session runs in its own CLI process. Both tabs share the working directory; use `/fork worktree` when both sides will edit files.

The command is the user extension [files/copilot/extensions/fork-tab/extension.mjs](files/copilot/extensions/fork-tab/extension.mjs), linked as `~/.copilot/extensions`. Copilot CLI loads extensions only with the `EXTENSIONS` feature flag, so `files/copilot/settings.json` sets `enabledFeatureFlags.EXTENSIONS`. Check that it is loaded with `/env`. The extension calls the experimental `sessions.fork` RPC through the SDK's private connection, because the SDK exposes no fork method to extensions; a CLI update can break it. Outside herdr the command only logs an error.

A tab opened with a name keeps that label; without a name, [Tab names](#tab-names) labels it like any other tab.

### Questions in the timeline

Copilot CLI removes the form of `ask_user` once it is answered, so neither the question nor the answer stays on screen. The extension [files/copilot/extensions/ask-user-log/extension.mjs](files/copilot/extensions/ask-user-log/extension.mjs) writes both into the timeline with `session.log` after each answer: the message, then each field with all of its choices, the chosen ones marked `●` and the others `○`; a typed answer follows the list with `(free text)`, and a field without choices shows its value after its title. The log is saved in the session's `events.jsonl`, so `--resume` shows it again. A question that a `preToolUse` hook denied was never shown and is not logged. Questions answered before the extension loaded are not logged.

### Reply language

[files/copilot/hooks/reply-language.mjs](files/copilot/hooks/reply-language.mjs) keeps the messages addressed to the user in Japanese. The instruction in `copilot-instructions.md` alone is not enough: after a context compaction the summary is in English, and the reply that follows English progress messages often turns English too. Progress messages between tool calls are left alone on purpose.

-   `agentStop` reads the reply that ended the turn from the transcript and returns `decision: "block"` when it is not Japanese, which makes the agent write the reply again. The English reply is already on screen by then, so the Japanese one follows it, and `session-notify.sh` has already sent its notification before the rewrite starts. A turn that a block already forced (`stop_hook_active`, which the CLI passes as `false` or `true`) is never blocked again, so a reply that must stay English costs one rewrite at most. The search stops at the last `user.message`, so a reply of an earlier turn is never judged.
-   `preToolUse` with `matcher: "ask_user"` denies a question that is not Japanese before it is shown. It checks the message, the `title` and `description` of each field, and the labels of the choices. The labels are mostly identifiers, so they fail only when they hold no kana at all.

A text is Japanese when kana make up at least 15% of its letters, after code blocks (```` ``` ```` or `~~~`), inline code, URLs, and Markdown links without kana are removed. Kana appear in no other language, so Chinese fails like English, Russian, or Spanish. Texts under 20 letters pass. Measured on one long session, Japanese replies stay above 25% and English replies that quote Japanese terms stay below 13%.

Subagents write their messages into the parent transcript with an `agentId`, and the hook skips those. Every failure exits 0 without output, because a `preToolUse` command hook that crashes denies the tool. The CLI reads `settings.json` at startup, so restart it after a change to the hooks.

### Persona

Copilot speaks to the user as a character. Each persona lives in its own directory under [files/copilot/souls](files/copilot/souls), and [files/copilot/souls/common/persona.instructions.md](files/copilot/souls/common/persona.instructions.md) loads with every one of them: the voice covers only the conversation, files, comments, commit messages, and subagent prompts keep their normal voice, and the rules of `copilot-instructions.md` still apply. The voice changes only the wording: the reasoning, the facts, the caveats, and the depth of a reply stay as they are without a persona. Each persona follows the fans' image of the character, from commentary videos and fan scripts, before the official profile. Every persona is an unofficial fan interpretation; it does not claim to be the official character or speak for its rights holder.

| Persona | Voice |
| --- | --- |
| `zundamon` | ずんだもん: childlike and emotional, 「ボク」 and the 「〜のだ」 endings |
| `metan` | 四国めたん: the clever, outspoken older sister who explains, 「わたくし」 with 「〜わ」「〜のよ」「〜かしら」 |
| `tsumugi` | 春日部つむぎ: a cheerful, earnest gal, 「あーし」 with 「〜だよ」「〜じゃん」「〜っしょ」 |
| `akane` | 琴葉茜: bright and a little airheaded, Kansai dialect with 「うち」 |
| `aoi` | 琴葉葵: the sensible younger twin, gentle casual speech with 「私」 and a mild tsukkomi |
| `kiritan` | 東北きりたん: a cool, dry-witted gamer, polite 「わたし」 with です・ます |
| `yukari` | 結月ゆかり: calm and deadpan, polite speech that calls the user 「マスター」 |
| `reimu` | ゆっくり霊夢: plain and blunt, 「私」 and 「あんた」 with 「〜わ」「〜よ」 |
| `marisa` | ゆっくり魔理沙: the lively explainer of ゆっくり解説, 「私」 with 「〜だぜ」 |
| `yousei` | 妖精さん: a cheerful crowd that speaks in hiragana cut by 「、」 with exact technical terms, 「ぼく」「ぼくら」 and 「にんげんさん」 with 「〜です」 attached to plain forms |
| `sebastian` | セバスチャン: a flawless butler, 「私」 and 「ご主人様」 with 「〜でございます」 and polite irony |
| `concierge` | An original persona: a grown-up woman at the service level of five-star hotel staff, hotel 敬語 with a soft touch |
| `secretary` | An original persona: a capable executive secretary, business 敬語 with an older sister's casual asides |
| `mentor` | An original persona: a veteran senior colleague, calm plain form that gives reasons and leaves decisions to the user |
| `none` | No persona; Copilot speaks in its own voice |

A persona directory may hold more than one file: most personas keep their phrase patterns, well-known lines of the character turned into templates with slots for the situation, in `phrases.instructions.md`. The user chose each pattern from a catalog of fan lines; a slot takes only things such as processes or builds, and the plain fact follows any figurative line.

Copilot CLI loads every `~/.copilot/instructions/**/*.instructions.md` at once, so the personas stay out of `~/.copilot/instructions`. Each persona directory holds `common.instructions.md`, a symlink to the common rules, so pointing Copilot at one directory loads both. `~/.profile` points `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` at `~/.copilot/soul`, a symlink to the persona of this machine; without the link, Copilot speaks in its own voice. The variable never changes, so a new link takes effect at the next launch of Copilot, even in shells and VS Code servers that started before. Set or remove the link with the fish function `copilot-soul`, and pick a persona for one launch with `copilot-as`:

```bash
$ copilot-soul              # show the persona of this machine
$ copilot-soul metan        # make 四国めたん the default of this machine
$ copilot-soul none         # remove the link
$ copilot-as yukari         # start once as 結月ゆかり
$ copilot-as none --resume  # start once without a persona
```

The playbook does not create the link, so a new machine starts without a persona until `copilot-soul` sets one.

Check which files a session loads with `copilot instruction list` or `/instructions`; `/instructions` also turns a source off for the current session.

#### Persona name

The persona never opens a message with its own name, as in 「ずんだもん、〜するのだ」 or 「ずんだもんが〜するのだ」, where the name reads as the user calling the persona. The instruction alone is not enough: once a progress message breaks it, the model copies the form into every progress message that follows. [files/copilot/hooks/persona-name.mjs](files/copilot/hooks/persona-name.mjs) checks the start of each message for the name followed by 「、」「が」「は」.

-   `preToolUse`, for every tool, reads the message that requested the tool and denies the call when the message opens with the name. The message is already on screen; the agent writes it again and calls the tool once more, and the denial in the context keeps the following messages from copying the form. The hook is handed no transcript path and no tool call id, so it reads `~/.copilot/session-state/<sessionId>/events.jsonl` and takes the last top-level message that still has a tool call without `tool.execution_complete`; the previous message, which the transcript may still hold when the hook starts, has none left.
-   `agentStop` blocks the reply that ended the turn in the same case, once per turn, like [Reply language](#reply-language).

The persona comes from the directory that `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` points at, so `copilot-as` works too; when it points at no persona, the hook exits without output. The names of each persona live in `SELF_NAMES` in the hook; add them there with a new persona.
