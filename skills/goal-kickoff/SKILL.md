---
name: goal-kickoff
description: Start any task. Do a small one directly, or turn it into one `/goal` brief or a plan of slices (a goal or a software migration) with its docs structure and first brief.
disable-model-invocation: true
---

# Kickoff

Start any task. Do a small one directly; otherwise write one brief for a `/goal` run, or turn a large ask into a **plan** of slices small enough for one `/goal` run each, set up the documents that let `/goal-loop` run it in any later session, and write the first brief. Beyond direct tasks, plan and leave building to `/goal`.

Plans, the `Next:` line and brief status are defined in [goal-next-slice](../goal-next-slice/SKILL.md#plans); briefs follow its [brief format](../goal-next-slice/BRIEF.md).

## Steps

1. **Read the ground.** Read `AGENTS.md` and the documents it marks mandatory, list `docs/`, and find the project's full check command (`bin/check`, `mix test`, `npm test`, …) or note that none exists. If an [open plan](../goal-next-slice/SKILL.md#plans) exists, stop and point to `/goal-loop`, unless the user asked for a separate plan. Done when you know the repository's conventions and its open plans.

2. **Classify the ask.**
   - **Migration**: rebuild an existing system (the source) in another language, framework or database with parity. Follow [MIGRATION.md](MIGRATION.md).
   - **Goal**: a bounded change in this repository, too large for one `/goal` run. Follow [GOAL.md](GOAL.md).
   - **Single slice**: it fits one run by the [sizing](../goal-next-slice/BRIEF.md#sizing). Pin its reference by step 3, write that one brief by steps 3–4 of goal-next-slice, show its Reference and Acceptance checklist and wait for explicit approval of both. Then call the `goal_start` tool with the brief's path, report the brief's path and its acceptance items in one line each, and stop: the goal starts in this session when the turn ends. Without that tool, copy and report by steps 5–6 of goal-next-slice instead.
   - **Direct**: a few edits finishable in this session with no acceptance checklist worth writing (a typo, a rename, a config value, a
     one-file fix). Write no files; say it needs no brief or `/goal`, and do it now.

   Confirm the class with the user when the ask does not make it plain. Done when the class is stated.

3. **Pin the reference and constraints.** Find by looking whatever looking can settle: source paths and commits, running copies, databases, test suites, toolchain versions, existing conventions. Then ask the mode file's questions that remain open, in one round, with your recommendation first. Done when every question has an answer or a recorded default.

4. **Scout and cut.** Read enough of the source or codebase to cut along real boundaries: namespaces, entry points, business areas. Follow the mode file's cutting rules. Done when every part of the ask maps to a milestone or slice, every milestone has a gate with a command, and the order respects dependencies.

5. **Get approval.** Show the plan in one compact view: milestones or slices with their gates, namespaces, decision authority and safety rules. Wait for explicit approval; revise on feedback. Done when the user approves.

6. **Write the structure.** Create every file in the mode file's layout, add its lines to `AGENTS.md`, and record durable rules through the `project-memory` skill. Done when each layout file exists and the plan's `Next:` names the first slice.

7. **Write the first brief.** Run steps 3–4 of [goal-next-slice](../goal-next-slice/SKILL.md) for the slice in `Next:`. Done when the brief exists and reads `Not started.`; `/goal-loop` runs it as the plan's first slice.

8. **Report.** List the files created, the milestones or slices in one line each, the decisions taken and their authority, and that `/goal-loop` runs the plan. Leave everything uncommitted for the user.
