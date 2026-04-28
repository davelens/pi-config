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

- **Local skills** — copied directly into this repo
- **Dotsys skills** (symlinks) — `dev-project-wiki`, `project-conventions`, `project-memory`, `searching-activecollab-history` point to my dotsys repo
