# pi-config

My Pi coding agent configuration. Clone to `~/.config/pi/` (or `~/.pi/agent/`) and run `setup.sh`.

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

## Editing the current input prompt in Neovim

`keybindings.json` maps Pi's built-in external editor action to `Ctrl+e`.

Pi uses `$VISUAL` first, then `$EDITOR`. If your launch environment might not set an editor, default it safely with:

```bash
EDITOR="${EDITOR:-nvim}" pi
```

While typing in Pi, press `Ctrl+e` to open the current input prompt in your editor. Save and quit to replace the Pi input box with the edited text. Run `/reload` in Pi or restart Pi after changing keybindings.

## Switching sessions with summaries

Use `/switch-session` to switch between sessions for the current project.

The smart switcher:

- shows a generated session summary, capped at 10 words
- stores generated/renamed summaries as Pi `session_info` names in each session JSONL
- uses the cheapest accessible configured GPT text model for missing summaries
- asks you to run `/login` or configure a GPT provider API key if no GPT model is accessible
- supports `j`/`k` to move down/up
- supports `Ctrl+r` to rename the highlighted summary
- supports `Ctrl+d` to confirm and delete the highlighted session history

`/resume` remains Pi's built-in session picker; extensions cannot override that literal command from this config repo.

## Adding packages

Edit `settings.json` and add to the `packages` array:

```json
"packages": [
  "npm:@plannotator/pi-extension",
  "git:github.com/other/pi-tools"
]
```

Then run `pi install <source>` for each one.

## Skills

Blank for now until `obra/superpowers` finishes its PR for pi adoption.
