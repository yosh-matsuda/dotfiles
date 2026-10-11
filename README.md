# dotfiles

Ansible-based dotfiles for my local development environment.

This repository applies shell settings, XDG config files, and CLI tools on Ubuntu, WSL, and macOS. It is meant to be re-run to keep the machine state consistent.

## What it sets up

-   dotfiles in the home directory
-   XDG config files
-   Homebrew packages
-   pipx packages
-   Docker on WSL
-   herdr and automatic startup in interactive SSH terminals
-   fish and fisher
-   WezTerm and VS Code on the Windows side of WSL

## Requirements

-   Python 3
-   Ansible
-   sudo access
-   Git

Install the required Ansible collection before the first run:

```bash
$ ansible-galaxy collection install -r collections/requirements.yml
```

## Usage

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

## Things to know

### herdr

-   herdr is installed with Homebrew, and its self-update is disabled for Homebrew installs. Detach, run `brew update && brew upgrade herdr`, then run `herdr` again to reconnect with the updated client. The running server keeps its old version; `herdr status` reports `update.restart_needed`, and only then is `herdr server stop` required.
-   Interactive SSH terminals start herdr automatically, except inside VS Code and herdr. Set `DOTFILES_NO_HERDR=1` to opt out, or use `ssh -t HOST 'bash --noprofile --norc -i'` for a recovery shell.
-   `Ctrl+b q` detaches the client and leaves the server and its panes running. herdr is started without `exec`, so detaching returns to the login shell instead of closing the SSH session, which is what the update flow above needs.
-   Panes inherit the environment of the long-lived `herdr server` process, so shell startup must not depend on inherited variables. A server auto-started by `herdr --remote` or a saved machine runs from a non-login SSH command and lacks `PATH` from `~/.profile`, so `[terminal] shell_mode = "login"` makes each pane run `~/.profile` itself. Interactive bash switches to fish based on its parent process, which keeps herdr panes on fish no matter where the server was started from.
-   Apply config changes with `herdr server reload-config`.
-   Only [files/herdr/config.toml](files/herdr/config.toml) is managed. Do not commit session snapshots, logs, sockets, or other runtime state from `~/.config/herdr`.
-   Existing tmux installations and configuration are left untouched and unmanaged.

### Copy and paste

One set of gestures holds in the VS Code integrated terminal and in WezTerm + herdr, for fish and for Copilot CLI alike:

| Action | Gesture | Exception |
| --- | --- | --- |
| Copy | Drag with the mouse; the text is copied when the button is released | Copilot keeps the copied text highlighted |
| Copy a word or a line | Double-click or triple-click; copied on release like a drag | herdr documents double-click only |
| Paste | `Ctrl+V` | |
| Copy or paste with the right button | Right-click copies and clears the selection if there is one, and pastes otherwise | Right after a drag the selection is still there, so it copies again; click once first or use `Ctrl+V`. In herdr, right-click opens the pane menu, and `Shift`+right-click pastes through the outer terminal |
| Open a link | `Ctrl`+click | In herdr, `Ctrl`+click makes the herdr client run `xdg-open` on its own host, which is the remote host over SSH; `Shift+Ctrl`+click lets the outer terminal open the link instead |
| Interrupt | `Ctrl+C`, which never copies; fish clears the line or interrupts the command, Copilot stops the turn | In Copilot, `Ctrl+C` copies again while a highlight remains, and cancels the `ask_user` question even with a selection; press `Esc` twice instead |
| Select in the outer terminal | `Shift`+drag, which bypasses herdr and Copilot | In herdr the selection includes the sidebar and pane borders |
| Block selection | `Alt`+drag | In herdr, `Shift+Alt`+drag |

Drag-to-copy is the only copy gesture that every layer can share. herdr can copy a kept selection only on `Ctrl+C` (or `Cmd+C`), so [files/herdr/config.toml](files/herdr/config.toml) pins `copy_on_select = true`; with `false`, herdr would take `Ctrl+C` as copy while a selection exists. Copilot gets `"copyOnSelect": true` for the same reason. Pressing `Esc` twice within half a second stops a Copilot turn regardless of the highlight; the first press only shows a hint. A click outside the highlight clears it.

The outer terminals run on Windows and are configured as described in [Windows applications](#windows-applications):

-   VS Code: `"terminal.integrated.copyOnSelection": true`, and the Windows default `Ctrl+C` copy is removed in `keybindings.json`. The Windows default `terminal.integrated.rightClickBehavior` is already `copyPaste`.
-   WezTerm: copies on every left-button release, including double-click, triple-click and `Alt` block selection, and trims the trailing spaces that block selection pads each line with. Right-click copies and clears the selection or pastes, and link opening moves to `Ctrl`+click with the `Ctrl` press bound to nothing so it does not reach the application. `Ctrl+V` pastes, and `Ctrl+C` and `Alt` keys reach the application, which means the default `Alt+Enter` full-screen toggle is disabled. `Ctrl+Shift+C` copies only a non-empty selection; the default `CopyTo` has no such check and can overwrite what herdr copied with an empty string.

### Windows applications

On WSL, the `windows` role writes into the Windows user profile through `/mnt/c`. Windows applications cannot read WSL symlinks, so the files are copied, and changes must be made in this repository and applied by running the playbook.

-   WezTerm: [files/windows/wezterm/wezterm.lua](files/windows/wezterm/wezterm.lua) is copied to `%USERPROFILE%\.config\wezterm\wezterm.lua` and replaces it entirely. Values that differ per machine go into a generated `machine.lua` next to it; the default domain is the WSL distribution that runs the playbook. Edits made directly on the Windows side are overwritten.
-   VS Code: only the keys in [files/windows/vscode](files/windows/vscode) are merged into `%APPDATA%\Code\User`; everything else stays with Settings Sync. When that directory does not exist, the merge is skipped with a message. Settings are overwritten key by key, and keybindings are appended when missing. The files are JSONC, so [files/scripts/vscode-settings-merge.mjs](files/scripts/vscode-settings-merge.mjs) edits them with `jsonc-parser`, the library VS Code itself uses, which keeps comments and formatting. The role installs it with `npm ci` into `files/scripts/node_modules` when it is missing.

### Tab names

Interactive fish shells inside herdr name numbered tabs after the foreground command via [files/scripts/herdr-tab-names.mjs](files/scripts/herdr-tab-names.mjs). Manually renamed tabs are left alone. Open a new fish shell inside herdr to pick up updates.

### Copilot CLI settings

`~/.copilot/settings.json` is merged, not symlinked, because Copilot CLI rewrites the file atomically. The merge is one way: keys tracked in `files/copilot/settings.json` are restored on every run, and local-only keys such as the `hooks` block are preserved. To keep a local change everywhere, copy it into `files/copilot/settings.json`.

The playbook reports local-only keys after the Copilot tasks. Check by hand with:

```bash
$ python3 files/scripts/copilot-settings-drift.py
```

`~/.copilot/hooks` is a symlink into this repository, so `herdr integration install copilot` writes into the working tree. Expect `files/copilot/hooks/herdr-agent-state.sh` to change when herdr updates.

### Reply language

[files/copilot/hooks/reply-language.mjs](files/copilot/hooks/reply-language.mjs) keeps the messages addressed to the user in Japanese. The instruction in `copilot-instructions.md` alone is not enough: after a context compaction the summary is in English, and the reply that follows English progress messages often turns English too. Progress messages between tool calls are left alone on purpose.

-   `agentStop` reads the reply that ended the turn from the transcript and returns `decision: "block"` when it is not Japanese, which makes the agent write the reply again. The English reply is already on screen by then, so the Japanese one follows it, and `session-notify.sh` has already sent its notification before the rewrite starts. A turn that a block already forced (`stop_hook_active`, which the CLI passes as `false` or `true`) is never blocked again, so a reply that must stay English costs one rewrite at most. The search stops at the last `user.message`, so a reply of an earlier turn is never judged.
-   `preToolUse` with `matcher: "ask_user"` denies a question that is not Japanese before it is shown. It checks the message, the `title` and `description` of each field, and the labels of the choices. The labels are mostly identifiers, so they fail only when they hold no kana at all.

A text is Japanese when kana make up at least 15% of its letters, after code blocks (```` ``` ```` or `~~~`), inline code, URLs, and Markdown links without kana are removed. Kana appear in no other language, so Chinese fails like English, Russian, or Spanish. Texts under 20 letters pass. Measured on one long session, Japanese replies stay above 25% and English replies that quote Japanese terms stay below 13%.

Subagents write their messages into the parent transcript with an `agentId`, and the hook skips those. Every failure exits 0 without output, because a `preToolUse` command hook that crashes denies the tool. The CLI reads `settings.json` at startup, so restart it after a change to the hooks.

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
