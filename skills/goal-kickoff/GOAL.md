# Goal mode

A goal's plan is `docs/briefs/<slug>-plan.md`, its slices are `docs/briefs/<slug>-NN-goal.md`, and each brief's Outcome is its evidence
record: no separate status log.

## Questions

- The outcome in one sentence, and how the user will judge it done.
- The reference to compare against: a spec, issue, design, existing feature or upstream document, named and fetchable. When the user names none, offer two or three concrete candidates.
- What is out of scope.
- Decision authority: delegate blocking decisions, or ask.
- Systems that must not be touched and integrations to fake.

## Cutting slices

- Slice 01 is a tracer bullet: the thinnest end-to-end path the full check can prove. Later slices widen it.
- One user-visible behaviour or one layer per slice; each ends green and committable.
- Two to eight slices. More means a migration-sized ask: use the [migration roadmap](MIGRATION.md#roadmap-skeleton) with milestones and
  without the parity parts.

## Layout

`docs/briefs/<slug>-plan.md`:

```markdown
# <Title> plan

Next: <SLUG>-01 — <one line>

## Ask

<the user's ask, verbatim>

## Reference

<named, fetchable, compared directly>

## Decisions

- <decision> (approved by the user | approved by delegation: <reason>)

## Slices

| ID | Slice | Depends on | Brief | Status |
|---|---|---|---|---|
| <SLUG>-01 | <one line> | — | [brief](<slug>-01-goal.md) | open |
| <SLUG>-02 | <one line> | <SLUG>-01 | — | open |

## Done when

The last slice's acceptance checklist adds these and removes this plan's line from `AGENTS.md`.

1. <final check for the whole goal> — Check: <command>. Pass: <condition>.
```

`AGENTS.md` gets one line:

```markdown
Active plan: `docs/briefs/<slug>-plan.md` (run with `/goal-loop`).
```
