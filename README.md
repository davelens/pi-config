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

## Goals and goal loops

`extensions/goal/` and its skills `goal-kickoff` and `goal-next-slice` form one workflow: start a task, cut it into
briefs a single `/goal` run can finish, and run those unattended. The extension parses the plan and brief formats the skills define
(the `Next:` line, `## Outcome` / `Not started.`), so change them together. The skills live in `extensions/goal/skills/`, outside
Pi's skill discovery, so they stay off the command list: `/goal-kickoff` and `/goal-loop` send them.

```text
/goal-kickoff <ask>   # at your desk: answer its questions, approve the plan or brief
/goal-loop            # walk away: brief, goal and commit per slice, each in a new session
```

- `/goal-kickoff <ask>` — start any task through the `goal-kickoff` skill. It sorts the ask into one of four classes:
  - **direct**: a few edits, done right away with no files;
  - **single slice**: one brief; once you approve its reference and acceptance checklist, it starts the `/goal` itself through the
    `goal_start` tool;
  - **goal**: 2–8 slices in `docs/briefs/<slug>-plan.md` and the first brief;
  - **migration**: a roadmap under `docs/migration/`, memory docs and the first brief.
- `/goal-loop [plan] [--max N]` — run a plan (`docs/migration/roadmap.md` or `docs/briefs/<slug>-plan.md`) slice by slice until its
  `Next:` line reads `none`, or for `N` slices
- `/goal-loop afk [plan] [--max N]` — the same, but you are away: every phase takes its own recommended option at a hiccup or open
  question instead of asking, and records it; permission or guardrail denials and destructive or outward-facing actions still block
- `/goal-loop status` — show the phase, slice and brief
- `/goal-loop step` — check the current phase again, after fixing what the loop waits for
- `/goal-loop stop` — end the loop; a pinned goal keeps running
- `/goal <text>` — pin a goal; `/goal pause|resume|status|clear` control it, also inside a loop
- `goal_start` (tool) — pins an approved, unstarted `docs/briefs/*-goal.md` as the goal

Each slice has three phases: the `goal-next-slice` skill writes the brief in a new session, `/goal <brief>` runs it in another new
session, and `/skill:git-commit` commits it there. Starting the loop is the permission to commit every slice. The loop moves on only
when a phase is finished: exactly one brief reads `Not started.`, the goal is done, HEAD has moved and the working tree is clean.
Otherwise it waits and says why; a blocked or paused goal continues the loop once `/goal resume` gets it done. Phone and desktop
notification switches follow the loop into each new session.

## Agent state

`extensions/agent-state/` lets other apps follow interactive (TUI) sessions. A reader listens on its own Unix socket in `$XDG_RUNTIME_DIR/agent-state/` (create the directory if it is missing), named `<reader>.sock`; dotshell uses `dotshell.sock`. Every session connects to every socket there, checking for new ones every 5 seconds, and sends one JSON line per change:

```json
{"provider": "pi", "pid": 1234, "status": "busy", "cwd": "/path", "title": "..."}
```

`status` is `busy`, `idle`, `error`, or `input`; `title` is the session name or the first prompt. The open connection is the liveness signal: when it closes, the session is gone. Other agents can use the same directory: dotshell's Claude Code hook sends one-shot lines with `"oneshot": true` and a final `"status": "gone"`.

## Skills

Skills load from the external directory `~/.config/agents/skills/pi`, wired via the `skills` array in `settings.json`.

## Editing the current input prompt in Neovim

`keybindings.json` maps Pi's built-in external editor action to `Ctrl+e`. It also maps the model selector to `Ctrl+s`, disables the default `Ctrl+p` quick-cycle model binding, and adds `Ctrl+n`/`Ctrl+p` navigation to Pi selectors like `/tree` and `/resume`.

Pi uses `$VISUAL` first, then `$EDITOR`. If your launch environment might not set an editor, default it safely with:

```bash
EDITOR="${EDITOR:-nvim}" pi
```

While typing in Pi, press `Ctrl+e` to open the current input prompt in your editor. Save and quit to replace the Pi input box with the edited text. Run `/reload` in Pi or restart Pi after changing keybindings.

