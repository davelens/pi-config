---
name: goal-next-slice
description: Write the brief for the next slice of the project's plan to docs/briefs/ and copy its `/goal` command to the clipboard.
disable-model-invocation: true
---

# Next slice

Turn the next open slice of the project's plan into a goal brief, then hand the user a paste-ready `/goal` command. Write the brief; leave its execution to `/goal`.

## Plans

A **plan** is the ordered list of slices toward one outcome, set up by `/goal-kickoff`:

- a migration: `docs/migration/roadmap.md` (milestones), with each namespace's cards in `docs/migration/<namespace>-map.md`;
- a goal: `docs/briefs/<slug>-plan.md`.

The line under a plan's title is `Next: <slice-id> — <one line>`, moved by each slice's closing acceptance item; the plan is **open** until it reads `Next: none — complete`. A brief's status is the first line under its `## Outcome`: `Not started.`, `Done <date>: …` or `Blocked: …`. List them all with `grep -A1 '^## Outcome' docs/briefs/*-goal.md`.

## Steps

1. **Load the project's rules.** Read `AGENTS.md` and every document it marks mandatory at session start. Pick the plan: the one the user named, else the open one among the paths above and any `AGENTS.md` points to. Several open and none named: ask which. None: stop and point to `/goal-kickoff`. Done when you know the plan and the constraints every slice carries.

2. **Find the next slice.** Take the plan's `Next:` slice; a plan without that line (older projects) gives its latest `Next:` pointer in the text or its first milestone not marked done. When that milestone is already sliced, the slice is its first open one; when it is too large for one goal (see [sizing](BRIEF.md#sizing)), slice it into finite, ordered slices and name the later ones. Check `docs/briefs/` for that slice's brief: `Not started.` means reuse it (skip to step 5); `Done` (the plan is stale) or `Blocked` means report it and stop. Done when you can name the slice's ID, its milestone and its predecessor's evidence.

3. **Gather the evidence.** Read the milestone's full section, the predecessor's brief and evidence record, and the code, tools, commands and pins the slice touches. Settle every factual question the brief would otherwise leave open. Done when each scope item names the files, commands or data it builds on.

4. **Write the brief** in the [brief format](BRIEF.md), matching the tone and naming of the most recent brief in `docs/briefs/`. A choice only the user can make (slicing that changes the milestone, dropping source behaviour, touching a system the rules guard) is asked before writing and recorded as "approved by the user"; every other choice is recorded as "approved by delegation". Done when the file exists and every scope item maps to an acceptance item.

5. **Copy the command.** Run `printf '%s' "/goal docs/briefs/<file>.md" | wl-copy` (X11: `xclip -selection clipboard`; macOS: `pbcopy`). Done when reading the clipboard back (`wl-paste`) gives exactly that line.

6. **Report.** Give the slice, the brief's path, its acceptance items in one line each, any decisions taken by delegation, and that the command is on the clipboard. Leave the brief uncommitted: it lands with the slice's own commit.
