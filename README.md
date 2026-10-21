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
- supports `Ctrl+y` to copy the highlighted session's full ID to the clipboard
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

## Goal loop

`extensions/loop-with-goal/` replaces the `pi-agent-loop` pass budget with an opt-in, evidence-based goal supervisor. It is auto-discovered; nothing happens until you pin a goal.

- `/goal <text>` — pin a goal and start a run. Requires a selected model with configured authentication. A pinned goal that is not done must be cleared first.
- `/goal pause` — stop automatic continuation durably.
- `/goal resume` — clear a user pause or a block and continue immediately when idle. It never retries cancelled or failed subagents; ask for that explicitly.
- `/goal status` (or `/goal`) — full goal text, state, latest evidence, failures, live subagents, and pending subagent outcomes.
- `/goal clear` — remove the goal (persisted as a tombstone).

The model reports through `goal_control({ action: "progress" | "done" | "blocked", evidence })`; evidence must name concrete checks (at least 20 characters). It cannot create, clear, or resume a goal. `done` means every acceptance criterion was judged met; `blocked` is for permission denials, missing access, or other obstacles and stays unfinished.

While a goal is active, a run that stops without `done`/`blocked` continues at Pi's `agent_before_settle` boundary with the pinned goal and latest evidence. Pi's native retries always finish first; if they are exhausted on a transient provider error, the supervisor retries from idle with exponential backoff (5s doubling to 60s, blocked after 10 consecutive failures). Missing auth, unavailable models, quota errors, and other permanent errors mark the goal blocked instead of looping, as do three consecutive stops without any tool activity. A finished async subagent wakes the idle parent once to inspect its report; a live or waiting child gates continuation; failed workers are never rerun automatically. After compaction, a hidden reminder re-pins the goal in context.

Any user cancellation pauses the goal until `/goal resume`: Escape in the main editor (including during a pending native retry or supervisor backoff), cancelling a child in the subagent viewer, cancelling a child's `contact_parent` questionnaire, cancelling a direct `ask_user_question`, and a guardrails user denial. The pause latch is a per-goal user-control ledger, so navigating `/tree` to an earlier snapshot does not resume a paused goal; progress and evidence stay branch-local. Reopening a session with an active goal continues it after 3 seconds; `/tree` navigation shows the branch state without auto-continuing.

The goal strip is a widget above the editor (`⚑ state · goal · detail`); the breadcrumb and editor are untouched, and supervision does not depend on rendering. Check with `node tests/loop-with-goal.test.mjs` (offline fake provider, real session runner, synthetic timers).

## Dotshell agent monitoring

`extensions/dotshell-agent-state/index.ts` auto-loads with this config and
publishes the current interactive Pi session per PID for dotshell's
`ai-agents-monitor`. Headless workers publish nothing. Records live under
`${XDG_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}/dotshell-agent-state`;
`PI_AGENT_STATE_DIR` overrides this for both Pi and dotshell.

Run `/reload` in existing Pi sessions after installing or updating the extension.
No explicit `extensions` setting or copy in the dotshell repo is needed.
Run its lifecycle checks with `bash tests/pi_agent_state_test.sh` (Node 22.6+).

## Adding packages

Edit `settings.json` and add to the `packages` array:

```json
"packages": [
  "npm:pi-mcp-adapter",
  "git:github.com/other/pi-tools"
]
```

Then run `pi install <source>` for each one.

## Bash session metadata

`extensions/pi-tool-display/config.json` disables only pi-tool-display's Bash
execution override. Version 0.5.0 drops the execution context required for Pi's
`PI_SESSION_FILE` and other session environment variables. Native Bash preserves
that context; pi-quiet-tools still provides compact rendering.

Run `/reload` after changing this setting. Verify with
`node tests/bash-session-environment.test.mjs` (requires the installed Pi and
pi-tool-display packages). The check covers session metadata and prevents
inheriting a stale session path in ephemeral sessions.

## Skills

Skills load from the external directory `~/.config/agents/skills/pi`, wired via the `skills` array in `settings.json`. There is no local `skills/` directory in this repo — Pi auto-discovers everything under that path.
