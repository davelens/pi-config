# Handoff: pi-subagents workflow findings

Date: 2026-06-03

## Context

The conversation explored how `pi-subagents` should fit into the user's existing Pi workflow. The user is a web developer who maintains `~/Repositories/blimp/raamwinkel` daily. That codebase is described as a 13-year-old, large legacy project with some questionable sections of code.

The user already has planning/challenge skills such as `grill-me` and `grill-with-docs`, and generally prefers to plan themselves before letting an agent do implementation work.

A config change was committed in this repo earlier:

- Commit: `00292b8 chore(config): update default model and packages`
- Changed `settings.json` default provider/model and added `npm:pi-subagents` to packages.

## Key findings

### Skills vs subagents

- Skills change how the current parent agent reasons or works.
- Subagents create separate child sessions with role boundaries, context isolation, async execution, and orchestration.
- `pi-subagents` is not inherently better than skills; it is better for delegation, isolation, parallel review, and async workflows.
- Existing skills like `grill-with-docs` remain better for interactive planning, domain-language sharpening, and clarifying decisions with the user.

### Planner agent is optional

The user can safely skip the `planner` subagent and continue using `grill-with-docs` plus their own planning process.

Using a `planner` subagent may introduce duplicated planning if the parent session already has a good interactive planning loop.

Recommended stance:

- Use `grill-with-docs` for tricky planning and domain-model work.
- Use `planner` only for non-interactive synthesis when the scope is already clear.
- Do not let a planner both create and approve its own recommendations.

### How subagents ask questions

A planner or worker subagent does not naturally conduct the same live dialogue as the parent session.

Question paths:

1. It can return open questions in its final output.
2. With intercom enabled, it can contact the parent/supervisor for a decision.
3. The parent agent can relay questions to the user.
4. `clarify: true` helps preview/edit launch parameters, but is not the same as live planning dialogue.

For interactive probing, `grill-with-docs` in the main session is preferable.

### Safe automation pattern

The risky pattern is:

```text
planner makes plan → planner follows own recommendations → worker implements
```

This gives the planner too much authority.

Safer pattern:

```text
parent/user clarifies
→ optional scout/context-builder/planner
→ parent approves scope
→ one worker implements
→ fresh-context reviewers inspect
→ one fix worker applies accepted fixes
→ parent final review
```

The parent session should remain the orchestrator and decision-maker.

## Recommended subagent layout for raamwinkel

### Daily default

```text
User + parent agent plan, often with grill-with-docs
→ worker implements approved scope
→ reviewer(s) inspect current diff
→ fix worker applies accepted fixes if needed
```

### Small maintenance fix

```text
user/parent plan
→ worker
→ one reviewer for regression/test gaps
```

### Risky legacy change

```text
scout or context-builder
→ user + grill-with-docs
→ worker
→ 3 parallel reviewers
→ fix worker
→ focused final reviewer if fix was substantial
```

### Unknown old code path

```text
parallel context-builders:
- current behavior/files
- risks/tests/coupling
→ parent/user plan
```

## Role recommendations

### `scout`

Use often for legacy recon:

- Find where behavior lives.
- Map old flows.
- Identify risky coupling before edits.

Suggested model: cheaper/fast model where possible; Qwen when local config is online; stronger model only for difficult cases.

### `context-builder`

Use for larger investigations spanning many files or concepts:

- Build handoff context.
- Summarize known behavior and risks.
- Prepare stronger implementation prompts.

Suggested model: Sonnet/GPT-class model; Opus for hard legacy reasoning.

### `worker`

Use as the sole writer after the plan is approved.

Recommended worker prompt constraints:

- Implement only the approved scope.
- Do not refactor adjacent legacy code unless required.
- Preserve existing behavior unless explicitly changed.
- Report changed files, commands run, validation evidence, risks, and unresolved decisions.
- Escalate unclear product/architecture/scope decisions.

Suggested model: OpenAI Codex/GPT coding model as daily default; Claude Sonnet/Opus for gnarly refactors; Qwen only for small/local edits when available.

### `reviewer`

Highest ROI role for the user's workflow.

Useful review angles:

1. Correctness/regressions.
2. Legacy coupling/side effects.
3. Tests/validation gaps.
4. Security/data/privacy for auth, forms, payments, uploads, admin, SQL, email, or other sensitive areas.

Use fresh context for adversarial review.

Suggested model: at least one strong reviewer, e.g. Claude Sonnet/Opus. Cheaper GPT/Codex/Qwen models can cover secondary angles.

### `oracle`

Use occasionally for architectural sanity checks:

- Is this making the legacy architecture worse?
- Should this be a narrow fix or small extraction?
- Is the migration/refactor strategy risky?
- Are there hidden assumptions or drift from the conversation?

Suggested model: Claude Opus/high-thinking.

### `planner`

Not recommended as a permanent daily default for this user.

Use only when:

- scope is already clear;
- interactive grilling is not needed;
- the parent will still review/approve the plan before implementation.

## Suggested persistent model override shape

Exact model identifiers should be adjusted to whatever Pi recognizes locally.

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": {
        "model": "openai/gpt-5-mini"
      },
      "context-builder": {
        "model": "anthropic/claude-sonnet-4"
      },
      "worker": {
        "model": "openai-codex/gpt-5.5"
      },
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high"
      },
      "oracle": {
        "model": "anthropic/claude-opus-4",
        "thinking": "high"
      }
    }
  }
}
```

## Suggested skills for next session

- `pi-subagents` — if configuring subagent overrides, testing workflows, or creating saved chains.
- `grill-with-docs` — for planning changes in `raamwinkel` against existing domain language/docs.
- `improve-codebase-architecture` — if looking for refactoring opportunities in the legacy codebase.
- `diagnose` — for debugging production/legacy failures.
- `git-commit` — for committing config/workflow changes.
- `project-memory` — if saving durable project-specific workflow decisions under `docs/memory/`.

## Open follow-ups

- Decide whether to add persistent `subagents.agentOverrides` to user settings or project settings.
- Confirm exact Pi model IDs for Claude MAX, OpenAI Codex/GPT models, and local llamacpp/Qwen.
- Consider creating saved prompt templates or chains for:
  - small maintenance fix;
  - risky legacy change;
  - unknown legacy code recon;
  - post-worker parallel review.
