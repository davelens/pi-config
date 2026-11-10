# TODO

## Prove `/goal-loop` on a real plan

`/goal-loop` automates `/skill:goal-next-slice` → `/goal <brief>` in a new session → commit → repeat. Its test drives the phases with a
fake model and an emulated session replacement; it has never run inside Pi.

- Run `/goal-kickoff` on a small real goal, then `/goal-loop --max 1`, and watch each hand-off: the brief session, the goal session, the
  commit, the `Next:` line.
- Then run a whole plan without `--max` with `/notify-phone on`, and check the phone hears every wait and the finish.
- The notify extension pings on every settle, three times per slice; quiet the ones where the loop moves on if that is too much.
