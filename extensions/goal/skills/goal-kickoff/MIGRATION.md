# Migration mode

A migration rebuilds a **source** system in a **target** stack with parity. The source stays read-only. Parity is judged against a
**pin** (one source commit) and, when the source can run, an **oracle**: a sacrificial running copy of the source at the pin with its own
data snapshot, polled only within a recorded scope.

## Questions

- Source location and pin (default: its current `HEAD`). Does a separate copy exist that may serve as the oracle (host, port, data)?
- Parity bars. Defaults: functional as close to 100% as possible, every difference recorded and approved; visual at least 95% of the
  same markup and screenshots; no redesign.
- Data: structural parity or data parity; where realistic data comes from; what is private.
- Namespaces (e.g. backend, frontend, API) and their order. Default: each namespace analysed and built before the next starts.
- Target stack, versions, and what is forbidden (e.g. Tailwind, a source dependency to drop).
- Decision authority: may Claude take blocking decisions by delegation while the user is away? Reserved by default: destructive actions,
  source writes, new oracle scopes, outbound integrations, commits and pushes.

## Layout

| Path | Content |
|---|---|
| `docs/briefs/initial.md` | The user's ask, verbatim. Never edited afterwards. |
| `docs/memory/coding-standards.md` | The parity contract, the analysis method, decision authority. |
| `docs/memory/safety.md` | Source read-only, the oracle and its allowed requests, data privacy, environment defaults. |
| `docs/migration/roadmap.md` | The plan (skeleton below). |
| `docs/migration/status.md` | Log, newest entry first: date, slice, commands run, results, next. |
| `docs/migration/<ns>-map.md` | Per namespace: pin, scope counts, cards (ID, title, depends on, owned entry points, specs to port). Written by its analysis milestone; kickoff creates a stub. |
| `docs/migration/<ns>/entry-points.tsv` | The ledger: `entry  kind  source  card  status  evidence`; status `missing`, `implemented`, `validated` or `dispositioned`. |
| `docs/migration/<ns>/<slice>-implementation.md` | Per-slice evidence, linked from the brief's Outcome. |

`AGENTS.md` gets:

```markdown
At the start of every session, before analysis or edits, read `docs/memory/coding-standards.md`, `docs/memory/safety.md` and
`docs/memory/index.md`. For migration work, also read the top of `docs/migration/roadmap.md` (its `Next:` line) and the newest entries
of `docs/migration/status.md`. Keep `docs/briefs/initial.md` unchanged. Run with `/goal-loop`.
```

When the full check runs longer than one tool call allows, record in coding-standards how to run it: in the background with an exit-code
marker file, polled in short calls.

## Roadmap skeleton

```markdown
# Migration roadmap

Next: <ID> — <one line>

Intent: [initial ask](../briefs/initial.md). Source: `<path>` at pin `<sha>`, read-only. Oracle: <host:port, data snapshot date> or none.
Target: this repository. Parity rules: [coding standards](../memory/coding-standards.md).

## Pinned versions

| Component | Version | Provenance |

## Execution contract (every slice)

- One slice per `/goal` run, in order; a failed prerequisite blocks its dependants.
- Port the source's tests before the behaviour they cover; synthetic fixtures only.
- A placeholder or a passing smoke test is not parity; ledger rows move to `implemented`/`validated` only with evidence.
- Each slice closes with focused tests, the full check, its evidence record, `status.md`, its milestone's row here and `Next:`.

## Stage gates

| Gate | Required result | Command | Result |

## Milestones

### <ID> — <title> (open)

Deliverables. Accept: <commands>. Slices: <ID> (done, [evidence](...)), **<ID>** (next), <ID>.
```

## Milestones

Default order. Drop what does not apply; keep every gate.

1. **BOOT** — the data (target schema, lossless import, verification against the source) and the runtime (pinned toolchain, development
   server, a `bin/check` that runs format, compile with warnings as errors, tests and a smoke boot). Gates: data verified; runtime green.
2. Per namespace, in the agreed order:
   1. **`<NS>`-AN, analysis.** The entry-point ledger: every route, command, job, webhook, socket, scheduled task and mounted engine of the
      namespace, each row owned by exactly one card. Cards are bounded (one business area, acyclic dependencies) and list the source
      specs to port. Inventory by entry point from the routing table and job registries, and trace each card to full depth when its slice
      starts: a file-by-file read-through of the whole source stalls. Reading and grep suffice; custom extraction tooling is no
      prerequisite. Gate: no unowned row, no unexplained gap. A large namespace is analysed in slices by business area.
   2. **HARNESS**, once, after the first analysis and before any implementation: `bin/parity` with `fetch` (one oracle page within the
      recorded scope), a structural DOM `diff`, a screenshot `visual` compare at fixed viewports, and the browser test harness. It starts
      small and grows per slice: capture plans, `gate <ns>` reading the ledgers, `verify-*` reconciliations. Gate: fetch, diff and the
      full check pass.
   3. **`<NS>` cards**, one at a time in dependency order, each sliced into briefs.
   4. **`<NS>`-CLOSE**: every ledger row `implemented`, `validated` or `dispositioned` with approval; `bin/parity gate <ns>` runs in the full
      check.
3. **QA**: end-to-end suites for the critical flows the ask names (e.g. the order flow), with their command.
4. **FINAL**: reconcile routes, data, assets, documents, jobs, protocols and SEO files; `bin/parity gate all`; a final-acceptance record
   and runbooks. A production cutover is the user's decision, outside the roadmap.

**PIN-NN**, a standing milestone in the roadmap, recurs whenever the source moves: diff the pins, port the schema drift, re-check the
affected done cards, recapture the touched oracle plans, and move the pin in tools and ledgers. Never mix revisions silently.

## IDs

A namespace has a two-letter abbreviation (`BE`, `FE`); a card is its letter and a number (`B04`, `F12`); a slice is the card and a letter
(`F12b`). Briefs: `<ns>-<card><letter>-goal.md` (`fe-f12b-goal.md`); milestone briefs `<id>-goal.md` (`boot01-goal.md`, `pin03-goal.md`).
