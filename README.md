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

## Switching sessions

Use `/switch-session` to switch between sessions for the current project.

- shows manually renamed session names when available, capped at 10 words
- falls back to the first message when a session has not been renamed
- stores renamed sessions as Pi `session_info` names in each session JSONL
- includes fuzzy search against session names/first messages; `Ctrl+c` clears search first, then cancels if search is empty
- supports `Ctrl+n`/`Ctrl+p` to move down/up
- shows up to 8 session items at once
- supports `Ctrl+r` to rename the highlighted session
- supports `Ctrl+y` to copy the highlighted session's full ID to the clipboard
- supports `Ctrl+d` to open a delete confirmation dialog for the highlighted session history

`/resume` remains Pi's built-in session picker; extensions cannot override that literal command from this config repo.

## Notifications

`extensions/notifications/index.ts` sends notifications when Pi settles. New sessions default to desktop notifications on and phone notifications off; changes persist when a session is resumed. Phone notifications use the ntfy endpoint in `~/.config/ntfy/pi-url`.

- `/notify-desktop on|off` — enable or disable desktop notifications
- `/notify-desktop` — show the desktop notification state
- `/notify-phone on` — notify the phone after every settled run
- `/notify-phone once` — notify the phone after the next settled run
- `/notify-phone off` — disable phone notifications
- `/notify-phone` — show the phone notification mode

## Condensed view

`extensions/condensed-output/` hides tool rows and thinking from the transcript. Each agent update gets a `[HH:MM]` prefix, and a trailing "Doing X:" sentence is shown in bold as "**Doing X**.". While the agent works, a single spinner line shows `Processing (thinking)` or `Processing (running tools)`; it disappears when the run settles. Only the display changes; the model sees the same messages and tool results.

- `/condensed` — toggle
- `/condensed on|off` — enable or disable (default on, remembered per session)

## Goals and plan loops

`extensions/plan-loop/` pins a goal and keeps the agent working until it reports the goal done or blocked with evidence, and runs a whole plan of such goals unattended.

- `/goal <text>` — pin a goal; `/goal pause|resume|status|clear` control it
- `/plan-loop [plan] [--max N]` — run a plan (`docs/migration/roadmap.md` or `docs/briefs/<slug>-plan.md`) slice by slice until its `Next:` line reads `none`, or for `N` slices
- `/plan-loop status` — show the phase, slice and brief
- `/plan-loop step` — check the current phase again, after fixing what the loop waits for
- `/plan-loop stop` — end the loop; a pinned goal keeps running

Each slice has three phases: `/skill:next-slice` writes the brief in a new session, `/goal <brief>` runs it in another new session, and `/skill:git-commit` commits it there. Starting the loop is the permission to commit every slice. The loop moves on only when a phase is finished: exactly one brief reads `Not started.`, the goal is done, HEAD has moved and the working tree is clean. Otherwise it waits and says why; a blocked or paused goal continues the loop once it is resumed and done. Phone and desktop notification switches follow the loop into each new session.

## Skills

Skills load from the external directory `~/.config/agents/skills/pi`, wired via the `skills` array in `settings.json`. There is no local `skills/` directory in this repo — Pi auto-discovers everything under that path.

## Editing the current input prompt in Neovim

`keybindings.json` maps Pi's built-in external editor action to `Ctrl+e`. It also maps the model selector to `Ctrl+s`, disables the default `Ctrl+p` quick-cycle model binding, and adds `Ctrl+n`/`Ctrl+p` navigation to Pi selectors like `/tree` and `/resume`.

Pi uses `$VISUAL` first, then `$EDITOR`. If your launch environment might not set an editor, default it safely with:

```bash
EDITOR="${EDITOR:-nvim}" pi
```

While typing in Pi, press `Ctrl+e` to open the current input prompt in your editor. Save and quit to replace the Pi input box with the edited text. Run `/reload` in Pi or restart Pi after changing keybindings.

