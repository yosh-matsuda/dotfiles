# dotfiles

Ansible-based dotfiles for my local development environment.

This repository applies shell settings, XDG config files, and CLI tools on Ubuntu, WSL, and macOS with Ansible, and sets up the Windows side of WSL with `winget configure`. It is meant to be re-run to keep the machine state consistent.

## What it sets up

On Ubuntu, WSL, and macOS, with the Ansible playbook:

-   dotfiles in the home directory
-   XDG config files
-   Homebrew packages
-   pipx packages
-   Docker on WSL
-   herdr and automatic startup in interactive SSH terminals
-   Pairfob for phone access to herdr on Ubuntu
-   fish and fisher
-   Copilot CLI settings, extensions, hooks, and personas

On Windows:

-   Windows applications, WSL, fonts, and key remapping, with `winget configure`
-   WezTerm and VS Code settings, copied from WSL by the `windows` role

## Getting started

### Bootstrap a new machine

[bootstrap.sh](bootstrap.sh) does the steps of [Manual setup](#manual-setup) on a new machine: it installs Git and Ansible with apt on Ubuntu, or Ansible with Homebrew on macOS, clones this repository into `~/dotfiles`, creates `local.hosts.yml` from the example when it is missing, installs the collection, and runs the playbook. `local.vars.yml` is optional and is left to you. Each step is skipped when it is already done.

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
5.  `bootstrap.sh` runs in the distribution. It asks for the Linux password twice: for `sudo` before `apt-get`, and at `BECOME password:` of the playbook.

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

## Windows

The Windows side comes from two places. [.config/configuration.winget](.config/configuration.winget) declares applications, Windows features, and key remapping, and `winget configure` applies it, from `bootstrap.ps1` or by hand. The `windows` role of the playbook copies application settings from WSL into the Windows user profile.

### Applications and features

[.config/configuration.winget](.config/configuration.winget) declares Virtual Machine Platform, WSL, Git, VS Code, PowerShell 7, Coreutils for Windows, uv, the Visual C++ runtimes, the WezTerm nightly build, the UDEV Gothic NF fonts that [wezterm.lua](files/windows/wezterm/wezterm.lua) uses, and the key remapping in [Keyboard](#keyboard). Check the machine against it without changing anything:

```powershell
> winget configure test -f .config\configuration.winget
```

-   Packages with `useLatest: true` are upgraded to the latest version whenever the configuration is applied, so rerunning `bootstrap.ps1` or `winget configure` works like `winget upgrade` for them, and `winget configure test` reports an outdated package. WSL is left out, because upgrading it restarts the WSL service and stops the running distributions; update it with `wsl --update`. VS Code is left out, because it updates itself.
-   Virtual Machine Platform is enabled by a script with `Enable-WindowsOptionalFeature`. winget installs DSC from Microsoft Store, and the `Microsoft.Windows/OptionalFeatureList` resource of that DSC stops with `This resource currently is not supported when installed via Appx`. `EnablePending` counts as enabled, because the feature takes effect after the restart that `bootstrap.ps1` asks for.
-   WezTerm and the fonts are installed by `Microsoft.DSC.Transitional/WindowsPowerShellScript` resources. The winget package `wez.wezterm.nightly` pins the SHA256 of an installer that the `nightly` tag replaces, so its install fails on a hash mismatch, and `wez.wezterm` is the 20240203 release. No winget package provides UDEV Gothic.
-   The WezTerm test passes for any installed WezTerm, so a rerun never updates it. Run the nightly installer again to update.
-   winget 1.29 `winget configure validate` warns that no module is specified and that the units are not public, and exits with 1, for this file and for the files that `winget configure export` writes alike. `winget configure test` and `winget configure` are not affected.

### Arm64

-   The same file serves x64 and Arm64 machines. On Arm64, winget picks the Arm64 installer of each package and falls back to x64 under emulation. WezTerm ships only an x64 build and runs emulated; the x64 Visual C++ runtime it needs installs on Arm64 too and carries the Arm64 binaries as well. uv for Arm64 depends on `Microsoft.VCRedist.2015+.arm64`, a separate package, so the elevated `VCRedistArm64` unit installs it before uv, which would otherwise raise a second elevation prompt. winget configure has no condition on a unit, so `VCRedistArm64` is a script that reports the desired state on other architectures and runs the `Microsoft.WinGet/Package` resource through `dsc.exe` on Arm64. Ubuntu, the Homebrew packages, Docker, and Pairfob all provide Arm64 builds for the playbook in WSL.
-   uv runs natively on Arm64 and, since uv 0.13.0, prefers native Arm64 Python. Wheels follow the architecture of the interpreter, and many packages publish `win_amd64` wheels without `win_arm64` ones, such as `torch`, `pyarrow`, and `grpcio` on 2026-10-26. To use x86_64 Python, which runs emulated, set `UV_PYTHON_ARCH=x86_64` yourself, or request it per environment: `uv venv --python cpython-3.14-windows-x86_64`.

### Keyboard

[.config/configuration.winget](.config/configuration.winget) remaps keys on Windows, for the Japanese (JIS) layout:

| Keys | Result | Unit |
| --- | --- | --- |
| Left `Ctrl`, `CapsLock` (英数) | swapped | `ScancodeMap` |
| `半角/全角`, `変換` | swapped | `ScancodeMap` |
| `無変換` + `i` `j` `k` `l` | `↑` `←` `↓` `→` | kanata |
| `無変換` + `u` `o` | `PageUp` `PageDown` | kanata |
| `無変換` + `a` `;` | `Home` `End` | kanata |
| `無変換` + `h` `d` | `Backspace` `Delete` | kanata |
| `無変換` + `Space` | `Enter` | kanata |

-   The swaps are one key to one key, so the registry value `Scancode Map` holds them. The keyboard driver rewrites the scancodes before any application sees them, so they hold in elevated windows, at sign-in, and without kanata. Windows reads the value at startup: restart after it changes. The unit replaces the whole value, including entries written by other tools.
-   A `無変換` layer needs a resident program. [kanata](https://github.com/jtroo/kanata) is a key remapper that runs natively on x64 and Arm64. Its winIOv2 build identifies keys by scancode, so `;` is the physical key right of `l` on JIS as well. `無変換` sends nothing by itself: a tap that sends `無変換` would have to tell a tap from a hold by timing, which misfires when typing fast. Keys outside `defsrc` never pass through kanata.
-   kanata runs elevated, or its layer would not reach elevated windows, so its executable and config live where only administrators can change them. `KanataPackage` installs the GUI and the console build of kanata into `%ProgramFiles%\kanata` from the GitHub release, checks their SHA256, resets their owner to Administrators and their ACLs to those inherited from Program Files, and its test fails while any account other than SYSTEM, Administrators, and TrustedInstaller can write to them. A writable executable would let an unelevated process replace what runs elevated. `KanataConfig` writes the config inline in the configuration file to `%ProgramFiles%\dotfiles\kanata.kbd`, and `KanataTask` registers the scheduled task `\dotfiles\kanata` that starts it with the highest privileges at sign-in, without a UAC prompt. The task runs at normal priority with no time limit, unlike the defaults of below normal and 72 hours. Its trigger repeats every minute while you are signed in, and a repetition is skipped while kanata runs, so kanata comes back within a minute after it exits for any reason, a crash or the emergency exit alike. The repetition comes from a time trigger in the past: the restart-on-failure setting of a task does not react to a process that exits, and the repetition of a logon trigger starts only at the next sign-in, not when the configuration registers and starts the task. A test task whose process exited with code 1 was never restarted by the former, and kanata stayed stopped with the latter. Rerunning the configuration restarts kanata when it is not running or started before the config was written.
-   kanata is pinned to `v1.13.0-prerelease-1`, whose binaries report themselves as `v1.13.0-prerelease-2`. v1.12.0, the latest release and the version in winget, compares the keys it holds with the Windows key state through US virtual-key codes. On JIS the key right of `l` is `VK_OEM_PLUS` (`0xBB`), not `VK_OEM_1` (`0xBA`), so every `;` raised `Unexpected keycode is pressed in kanata but not in Windows` as a notification, and v1.12.0 has no option to stop the check. The prerelease adds `windows-sync-keystates none`, which the config sets. The other keys of the layer map to the same virtual-key codes on JIS and US.
-   The release publishes no checksums, so `KanataPackage` pins the SHA256 of the files downloaded on 2026-10-27. To update kanata, change `version` and the hashes of `KanataPackage` and apply the configuration; the unit stops kanata first, because a running kanata locks its executable. The unit also uninstalls `jtroo.kanata_gui`, which an earlier version of the configuration installed with winget.
-   To change the layer, edit the `content` of `KanataConfig` and apply the configuration. Validate a config without hooking the keyboard with the console build: `& "$env:ProgramFiles\kanata\kanata_windows_tty_winIOv2_x64.exe" --cfg <file> --check`, or `_arm64.exe` on Arm64. Bump `revision` of `KanataTask` when its task definition changes.
-   kanata does not reach the secure desktop, such as UAC prompts and the lock screen, where only the `Scancode Map` swaps apply. `LCtrl` + `Space` + `Esc` stops kanata in an emergency, and the task starts it again within a minute; with the swap, `LCtrl` is the key labeled `CapsLock`. To keep kanata stopped, run `Disable-ScheduledTask -TaskPath '\dotfiles\' -TaskName kanata` in an elevated PowerShell before stopping it; applying the configuration registers the task again, enabled.

### Application settings

On WSL, the `windows` role writes into the Windows user profile through `/mnt/c`. Windows applications cannot read WSL symlinks, so the files are copied, and changes must be made in this repository and applied by running the playbook.

-   WezTerm: [files/windows/wezterm/wezterm.lua](files/windows/wezterm/wezterm.lua) is copied to `%USERPROFILE%\.config\wezterm\wezterm.lua` and replaces it entirely. Values that differ per machine go into a generated `machine.lua` next to it; the default domain is the WSL distribution that runs the playbook. Edits made directly on the Windows side are overwritten.
-   WezTerm and GPU loss: when the OpenGL context is lost, for example when an external GPU is unplugged, WezTerm closes the GUI window but never recreates it, so the panes and their WSL shells keep running unseen. A herdr client left in such a process repeats every notification. Every 5 seconds the config checks for mux windows in the active workspace while no GUI window exists; after two hits in a row it starts a new `wezterm-gui.exe start --always-new-process` and exits, which also ends the old WSL shells. Rendering cannot simply be pinned to the integrated GPU: the per-app Windows graphics preference does not reach WGL here, the ANGLE path (`prefer_egl`) follows it but loses window transparency, and `front_end = 'Software'` still loads the system `opengl32.dll` because `wezterm-gui.exe` imports it statically.
-   VS Code: only the keys in [files/windows/vscode](files/windows/vscode) are merged into `%APPDATA%\Code\User`; everything else stays with Settings Sync. When that directory does not exist, the merge is skipped with a message. Settings are overwritten key by key, and keybindings are appended when missing. The files are JSONC, so [files/scripts/vscode-settings-merge.mjs](files/scripts/vscode-settings-merge.mjs) edits them with `jsonc-parser`, the library VS Code itself uses, which keeps comments and formatting. The role installs it with `npm ci` into `files/scripts/node_modules` when it is missing.

## Terminal

### herdr

-   herdr is installed with Homebrew, and its self-update is disabled for Homebrew installs. Detach, run `brew update && brew upgrade herdr`, then run `herdr` again to reconnect with the updated client. The running server keeps its old version; `herdr status` reports `update.restart_needed`, and only then is `herdr server stop` required.
-   Interactive SSH terminals start herdr automatically, except inside VS Code and herdr. Set `DOTFILES_NO_HERDR=1` to opt out, or use `ssh -t HOST 'bash --noprofile --norc -i'` for a recovery shell.
-   `Ctrl+b q` detaches the client and leaves the server and its panes running. herdr is started without `exec`, so detaching returns to the login shell instead of closing the SSH session, which is what the update flow above needs.
-   Panes inherit the environment of the long-lived `herdr server` process, so shell startup must not depend on inherited variables. A server auto-started by `herdr --remote` or a saved machine runs from a non-login SSH command and lacks `PATH` from `~/.profile`, so `[terminal] shell_mode = "login"` makes each pane run `~/.profile` itself. Pane commands ignore `shell_mode`, so the VS Code shortcut loads `~/.profile` explicitly before invoking `code` or the VS Code remote CLI. The shortcut embeds a bash port of the fish function `code-remote`, so it works without fish; change both together. On WSL, a server that Pairfob starts through systemd lacks `WSL_DISTRO_NAME` and the Windows `PATH`, which `code` needs, so `~/.profile` restores both when `WSL_DISTRO_NAME` is unset. Interactive bash switches to fish based on its parent process, which keeps herdr panes on fish no matter where the server was started from.
-   Apply config changes with `herdr server reload-config`.
-   Only [files/herdr/config.toml](files/herdr/config.toml) is managed. Do not commit session snapshots, logs, sockets, or other runtime state from `~/.config/herdr`.
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
| Open a link | `Ctrl`+click | In herdr, `Ctrl`+click opens only `http(s)` links, in the browser of the host that runs the herdr client. `Shift+Ctrl`+click lets the outer terminal open a URL that is visible as text; since herdr 0.9.4, herdr no longer passes OSC 8 hyperlinks to the outer terminal while `ui.mouse_capture` is on, so a labeled link does not open this way. `code-remote` prints its `vscode://` URI as text for this reason |
| Interrupt | `Ctrl+C`, which never copies; fish clears the line or interrupts the command, Copilot stops the turn | In Copilot, `Ctrl+C` copies again while a highlight remains, and cancels the `ask_user` question even with a selection; press `Esc` twice instead |
| Select in the outer terminal | `Shift`+drag, which bypasses herdr and Copilot | In herdr the selection includes the sidebar and pane borders |
| Block selection | `Alt`+drag | In herdr, `Shift+Alt`+drag |

Drag-to-copy is the only copy gesture that every layer can share. herdr can copy a kept selection only on `Ctrl+C` (or `Cmd+C`), so [files/herdr/config.toml](files/herdr/config.toml) pins `copy_on_select = true`; with `false`, herdr would take `Ctrl+C` as copy while a selection exists. Copilot gets `"copyOnSelect": true` for the same reason. Pressing `Esc` twice within half a second stops a Copilot turn regardless of the highlight; the first press only shows a hint. A click outside the highlight clears it.

The outer terminals run on Windows and are configured as described in [Application settings](#application-settings):

-   VS Code: `"terminal.integrated.copyOnSelection": true`, and the Windows default `Ctrl+C` copy is removed in `keybindings.json`. The Windows default `terminal.integrated.rightClickBehavior` is already `copyPaste`.
-   WezTerm: copies on every left-button release, including double-click, triple-click and `Alt` block selection, and trims the trailing spaces that block selection pads each line with. Right-click copies and clears the selection or pastes, and link opening moves to `Ctrl`+click with the `Ctrl` press bound to nothing so it does not reach the application. `Ctrl+V` pastes, and `Ctrl+C` and `Alt` keys reach the application, which means the default `Alt+Enter` full-screen toggle is disabled. `Ctrl+Shift+C` copies only a non-empty selection; the default `CopyTo` has no such check and can overwrite what herdr copied with an empty string.

## Copilot CLI

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
