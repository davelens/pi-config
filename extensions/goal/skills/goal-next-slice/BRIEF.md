# Brief format

A brief is the only input of one `/goal` run: `docs/briefs/<slice-id>-goal.md`, lowercase (`fe-f12b-goal.md`, `pin09-goal.md`,
`search-02-goal.md`). Every fact the run needs is in it or linked from it.

## Sizing

One slice is one `/goal` run that ends with a green full check and a commit. A slice is too big when it has more than about eight
acceptance items, more than one new user-visible flow, an acceptance item that says "all" without a command that counts, or a question
only the user can answer. Split it by entry points (routes, commands, jobs, screens) of one card or feature, and name the siblings in
Slicing.

## Sections, in order

1. **`# <SLICE-ID> goal: <outcome>`** and one context paragraph: the plan and card it belongs to, the pin (migrations), the predecessor
   with a link to its evidence, and the modules it builds on by name.
2. **`## Slicing`**: every sibling slice, done ones marked `(done)`, this one in bold, later ones named; who approved the slicing.
3. **`## Scope`**: per entry point, the source files, behaviour, markup, error cases and the tests to port first (paths). Facts are settled
   here; "trace" or "find out" only for what needs running the slice itself.
4. **`## Decisions`**: each choice marked `approved by the user` or `approved by delegation`, with its reason; repairs versus kept-as-source;
   the safety scope (systems touched, writes allowed, integrations faked) copied from the project's safety rules.
5. **`## Reference`**: the source checkout at the pin, the oracle, a spec, an upstream document. Named, fetchable and directly comparable:
   a specific artifact, product, repository or publication. The run obtains the actual reference and compares against it directly.
6. **`## Inventory`** (optional): a table of the entry points in scope.
7. **`## Acceptance checklist`**: finite, scoped, numbered items, each with `Check:` (an exact command or observation against the actual
   reference or implementation tests; UI checks can require same-state, same-viewport captures) and `Pass:` (its condition). Include the
   user's measurable requirements; add no cost ceiling unless asked. Order:
   tests first, no real integration traffic, parity against the Reference, browser or end-to-end, records. The last item is always the
   records: this brief's Outcome, the plan's slice row and its `Next:` line, the project's evidence record and status log where it keeps
   them (a migration does), then the project's full check command. Pass: exit 0.
8. **`## Outcome`**: `Not started.`, then a comment telling the run to replace that line with `Done <YYYY-MM-DD>: …` (evidence, counts,
   differences, follow-ups) or, when it stops short, `Blocked: …` (the cause and what unblocks it).
