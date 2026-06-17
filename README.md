# pi-config

My Pi coding agent configuration. Clone to `~/.config/pi/` and run `setup.sh`.

## Structure

```
├── settings.json    # Global settings (provider, model, packages)
├── models.json      # Custom provider/model definitions
├── skills/          # Skills — local copies + symlinks to dotsys
├── extensions/      # Pi extensions (TypeScript)
├── prompts/         # Prompt templates
└── themes/          # Custom themes
```

## Setup on a new machine

```bash
git clone git@github.com:davelens/pi-config ~/.config/pi
cd ~/.config/pi && chmod +x setup.sh && ./setup.sh
```

Or just clone and run `pi` — it auto-discovers skills, extensions, prompts, and themes.

This config keeps Pi's global agent directory XDG-style at `~/.config/pi`. Pi core can use that directly via `PI_CODING_AGENT_DIR=~/.config/pi`; `setup.sh` also creates a compatibility symlink so older packages that hardcode `~/.pi/agent` resolve back into `~/.config/pi` instead of creating a real `~/.pi` directory.

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

Blank for now until `obra/superpowers` finishes its PR for pi adoption.
