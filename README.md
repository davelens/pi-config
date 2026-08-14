# pi-config

My Pi coding agent configuration. Clone to `~/.config/pi/` and run `setup.sh`.

## Structure

```
├── settings.json    # Global settings (provider, model, packages)
├── models.json      # Custom provider/model definitions
├── extensions/      # Pi extensions (TypeScript)
└── themes/          # Custom themes
```

## Setup on a new machine

```bash
git clone git@github.com:davelens/pi-config ~/.config/pi
cd ~/.config/pi && chmod +x setup.sh && ./setup.sh
```

Or just clone and run `pi` — it auto-discovers skills, extensions, prompts, and themes.

This config keeps Pi's global agent directory XDG-style at `~/.config/pi`. Set `PI_CODING_AGENT_DIR=~/.config/pi`; `setup.sh` does not create Pi's legacy `~/.pi` directory.

## Editing the current input prompt in Neovim

`keybindings.json` maps Pi's built-in external editor action to `Ctrl+e`. It also maps the model selector to `Ctrl+s`, disables the default `Ctrl+p` quick-cycle model binding, and adds `Ctrl+n`/`Ctrl+p` navigation to Pi selectors like `/tree` and `/resume`.

Pi uses `$VISUAL` first, then `$EDITOR`. If your launch environment might not set an editor, default it safely with:

```bash
EDITOR="${EDITOR:-nvim}" pi
```

While typing in Pi, press `Ctrl+e` to open the current input prompt in your editor. Save and quit to replace the Pi input box with the edited text. Run `/reload` in Pi or restart Pi after changing keybindings.

## Switching sessions

Use `/switch-session` to switch between sessions for the current project.

The smart switcher:

- shows manually renamed session names when available, capped at 10 words
- falls back to the first message when a session has not been renamed
- stores renamed sessions as Pi `session_info` names in each session JSONL
- includes fuzzy search against session names/first messages; `Ctrl+c` clears search first, then cancels if search is empty
- supports `Ctrl+n`/`Ctrl+p` to move down/up
- shows up to 8 session items at once
- supports `Ctrl+r` to rename the highlighted session
- supports `Ctrl+d` to open a delete confirmation dialog for the highlighted session history

`/resume` remains Pi's built-in session picker; extensions cannot override that literal command from this config repo.

## Notifications

`extensions/notify/index.ts` sends notifications when Pi settles. New sessions default to desktop notifications on and phone notifications off; changes persist when a session is resumed. Phone notifications use the ntfy endpoint in `~/.config/ntfy/pi-url`.

- `/notify-desktop on|off` — enable or disable desktop notifications
- `/notify-desktop` — show the desktop notification state
- `/notify-phone on` — notify the phone after every settled run
- `/notify-phone once` — notify the phone after the next settled run
- `/notify-phone off` — disable phone notifications
- `/notify-phone` — show the phone notification mode

## Adding packages

Edit `settings.json` and add to the `packages` array:

```json
"packages": [
  "npm:pi-mcp-adapter",
  "git:github.com/other/pi-tools"
]
```

Then run `pi install <source>` for each one.

## Skills

Skills load from the external directory `~/.config/agents/skills/pi`, wired via the `skills` array in `settings.json`. There is no local `skills/` directory in this repo — Pi auto-discovers everything under that path.
