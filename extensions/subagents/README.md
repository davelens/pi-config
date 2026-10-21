# Lo-fi subagents

A small replacement for `pi-subagents`: one foreground tool, in-process Pi SDK sessions, and Markdown agent definitions.

## Use

```text
subagent({ action: "list" })
subagent({ action: "run", agent: "scout", task: "Trace the login flow." })
subagent({ action: "run", agent: "reviewer", task: "Review the diff.", async: true })
subagent({ action: "wait", runId: "..." })
subagent({ action: "status" })
subagent({ action: "stop", runId: "..." })
subagent({ action: "continue", runId: "...", async: true })
```

Pi already executes sibling tool calls concurrently, so parallel foreground work is multiple `subagent` calls in one turn. Broad implementation work is planned as independently verifiable slices and assigned to sequential workers; implementation and focused tests stay in the same slice. Each slice runs once, and retries or additional validation agents require an explicit user request. Every child is instructed to return only the requested deliverable and blockers, concisely, then stop. Every child also gets `contact_parent`, which takes the same 1-4 structured questions (2-4 options each) as the installed `@juicesharp/rpiv-ask-user-question` tool and opens that questionnaire in the parent UI while the child's tool call blocks and its writer lock stays held; the run shows as `waiting` with its pending questions until the user answers. The user's answer becomes the child's tool result, so the same turn continues, and the parent never answers for the user. Pressing Esc aborts that child, releases its lock, and returns the unanswered questions to the parent, which then chooses a task-dependent safe alternative, starts a new subagent, or reports the blocker; nothing retries or re-prompts. A UI that cannot show the questionnaire (no UI, RPC host without dialogs, load failure) fails the run with the questionnaire's own error instead. Questionnaires from concurrent children open one at a time, and `stop` or shutdown dismisses an open one. A cancelled or failed async run notifies and steers the parent at the next tool boundary; a completed one only notifies. Set `async: true` to return immediately while a child continues in-process; `action: "wait"` awaits that run's tracked promise without polling. Cancelling `wait` cancels only that waiter, never the detached child. Live run tracking remains process-local: `status`, `wait`, and `stop` do not restore running processes after Pi reload, session replacement, or process exit. Explicit `continue` can reopen a checkpointed, cancelled child from the current parent session's saved history. `/subagents-history` separately restores recorded history for the current parent session. Shutdown aborts active children gracefully. Only one mutation-capable agent (one with `bash`, `edit`, or `write`) can run per Git worktree (or working directory outside Git), whether foreground or async. Shipped read-only agents omit unrestricted `bash`, so they can run concurrently. The reviewer gets `git_inspect`, limited to read-only diff, log, and status operations; the researcher gets a shell-free `ketch` tool with an allowlist of supported CLI flags. Every child loads the configured guardrails policy extension. Runtime limits and stall detection are described below.

## Lifecycle events

`lifecycle.ts` publishes typed run transitions on `pi.events` under `subagents:lifecycle` for other extensions (the goal loop uses them): `started` before any child work, `waiting`/`running` around a `contact_parent` questionnaire, `cancelled` with `source: "viewer"` or `"questionnaire"` before the child's controller is aborted, and `finished` with the terminal `completed`/`failed`/`aborted` status after prompt settlement and lock release. Every event carries `parentSessionId`, `runId`, agent, task, report path, and whether the run was detached (async). A listener that sets `claimed = true` on a `finished` event synchronously owns the parent's next step, so the runner skips its own `triggerTurn` wake-up for that failed or cancelled async run; unclaimed events keep the existing behavior. Emitting `subagents:live-runs` with `{ runs: [] }` fills the array with currently running or waiting runs synchronously.

## Deadlines and stalls

Omitted `timeoutMs` means no total-runtime deadline. A positive configured value remains an explicit wall-clock budget across routing, setup and fallbacks, including questionnaire time. Existing definitions and overrides are preserved: remove their `timeoutMs` to opt out, then reload the extension after upgrading.

The watchdog monitors each child without extra model calls:

- **Silence:** never triggers a warning or stop, including long reasoning and silent tools. There is no inactivity timer.
- **Exact repetition:** warn on a consecutive 1–4-call tool/arguments/result cycle spanning at least six cycles, twelve calls, multiple assistant turns and five minutes. Stop only after five further active minutes and at least two additional cycles. Changed calls/results clear loop evidence; reassuring prose does not. Parallel results are compared in call-start order, with nested calls excluded from double counting.
- **User input:** queued and open `contact_parent` calls freeze watchdog clocks, including recovery grace. Explicit deadlines still apply.

Warnings request concrete findings and a changed approach or partial result through child steering, notify the parent without starting a parent turn, and persist in reports/history. Steering queued behind a turn/tool is not yet delivered. Grace expiration alone never aborts a child; further repeated calls/results are required. Stalls fail with a specific reason and never fall back or restart automatically. Transcripts and saved files remain available. Cancellation is cooperative: the writer lock stays held until prompt and abort settle.

These are suspicion signals, not semantic progress detection. Legitimate exact polling can be flagged; changing-but-unproductive work can evade detection. A completely silent hang requires a manual stop (or an explicitly configured deadline). No files-written requirement is imposed on research agents.

## Manage agents

Run `/subagents` to open the two-pane manager:

- `ctrl+n`/`ctrl+p` or `j`/`k` select agents in the sidebar.
- `h`/`l` switch between the sidebar and file view.
- `j`/`k` scroll the selected Markdown file in the file view.
- `ctrl+e` edits the entire Markdown definition with `$EDITOR` (default: `nvim`).
- `c` creates a global agent while the sidebar is focused, then opens its definition in the editor.
- `e` renames the selected agent and its Markdown file while the sidebar is focused.
- `d` deletes the selected agent after a confirmation dialog.
- `ctrl+shift+r` restores shipped defaults from the sidebar after a destructive confirmation.
- `*` marks a managed definition that differs from its shipped default.
- `esc` closes the manager.

Run `/subagents-status` while at least one subagent is active to inspect every run started in the current Pi process, including foreground runs and completed siblings. After five minutes without observable assistant output/thinking or tool start/progress/result, the agent turns yellow and shows its quiet duration. This is informational, never an inactivity warning or stop. Reads count as activity; queued/open questionnaires pause quiet time. The selected run's current model and effective thinking level appear above the output, updating when a fallback starts; live input tokens, output tokens, and cost appear at the top right. The popup follows the latest message by default; use `j`/`k` to scroll, `{`/`}` to jump ten rows, `gg`/`G` to jump to the top/bottom, and `ctrl+n`/`ctrl+p` or the sidebar to switch runs. A single run uses the full panel without a sidebar. If nothing is running, Pi shows an inline message instead of opening the popup.

Run `/subagents-history` to browse runs recorded in the current parent session, even when none are active or after reloading/resuming Pi. It includes all branches in that session, not other sessions or inherited fork history, using the same viewer and navigation. Only runs started after installing this feature are recorded. Saved snapshots retain task, outcome, output/error, and child-session paths independently of pruned Markdown reports. Available child transcripts (including fallback attempts) restore messages and usage; missing transcripts show a notice and the saved result. Interrupted runs without a live handle are shown as aborted. Historical runs cannot be waited on or stopped. Cancelled runs with checkpoints offer explicit continuation; newly continued attempts have live controls.

Press `v` in either viewer to inspect the latest model-request context and current tool arguments. Silent runs show this inspection view automatically. The request excerpt is captured at Pi's `context_with_system` boundary: the last four non-system messages, capped at 16,000 characters, not a raw HTTP payload or a reconstruction from later messages. Images, opaque reasoning/signature blocks and obvious credential-named fields are omitted. Arbitrary text may still contain private data, like the existing transcript; snapshots stay local in a private, overwritten-per-attempt file alongside the report. Missing/pruned snapshots are labelled unavailable. The viewer refreshes while open, including when the child emits nothing.

### Cancel and continue

- **`c` — Cancel:** abort the selected live child and wait for settlement. Its transcript, completed file changes, original assignment, configuration fingerprint and child-session checkpoint are saved. Cancellation does not roll back files or external effects.
- **`r` — Continue:** explicitly reopen a cancelled child's exact session and assignment. This also works through `/subagents-history` after reload or resuming the same parent session. A linked new run report preserves the original cancellation record. Model routing and fresh-session fallbacks are bypassed.

Continuation sends a new request, not a restoration of the provider's hidden state. It instructs the worker to inspect interrupted effects before retrying tools; existing tools are not automatically replayed. Continue refuses missing/corrupt/stale transcripts, different working directories, changed agent configurations, unavailable models, or conflicting worktree/child-session locks. Child-session locks apply to readers too. Older runs without a checkpoint, hard crashes before a checkpoint was saved, completed/failed runs and runs from another parent session cannot be continued this way. Nothing resumes automatically; tool callers must have an explicit user request for `action: "continue"`.

Run `/subagents-doctor` for the same style of scrollable popup covering malformed definitions, unavailable models, invalid tools, configured or missing skills, Pi skill diagnostics, guardrails, and active runs.

The deliberately awkward restore shortcut is shown in the footer so it remains discoverable without being easy to trigger accidentally. The manager shows save/error feedback in its footer. All editable agents live in `~/.config/agents/pi/`.

## Configure agents

Override bundled or custom agents in global `settings.json`, or in a trusted project's `.pi/settings.json`:

```json
{
  "subagents": {
    "aliases": {
      "architect": "planner",
      "coder": "worker"
    },
    "agentOverrides": {
      "reviewer": {
        "model": "openai-codex/gpt-5.6-sol",
        "thinking": "high",
        "timeoutMs": 600000,
        "fallbackModels": ["claude-bridge/claude-fable-5"],
        "tools": ["read", "grep", "find", "ls", "git_inspect"]
      }
    }
  }
}
```

Project settings override global settings. `aliases` maps alternate names to configured agents; direct agent names take precedence over aliases. Supported overrides are `description`, `model`, `fallbackModels`, `thinking`, `timeoutMs`, `skills`, and `tools`. Set `model` to `null` to inherit the parent model. `skills` is an array of Pi skill names. A project override cannot grant `bash`, `edit`, or `write` to an agent whose effective global definition lacks that tool. Unsupported tool names are reported and block the run instead of being silently ignored. Overrides only configure an agent that has a Markdown definition; they do not define its prompt. `/subagents` renders these effective values in the file view without changing the Markdown file.

## Route models with Jev

Run `/subagents-decision-model on` to let TypeSafe's Jev pick the model and thinking level for each new subagent run; `off` restores the configured defaults, and no argument prints the current state. The toggle is stored as `subagents.decisionModel` in the global `settings.json` only; project settings are ignored. It is off by default. Other keys in the file are preserved, and a malformed settings file is reported instead of being overwritten.

Authenticate with Pi's native `/login typesafe` flow, then run `/subagents-decision-model on`; use `/subagents-decision-model key` for a reminder. Native provider credentials are stored in Pi's `auth.json`, with stored auth taking precedence over `TYPESAFE_API_KEY`. The legacy `typesafe-credentials.json` file is unused and intentionally left untouched. Jev routing uses Pi's built-in classifier registry directly; it does not require enabling Codemode or an MCP server.

Before every new run, the extension calls Pi's native `typesafe/jev-latest` classifier with the task, agent name, description, and tools, and one option per valid model/thinking pair: `provider/id`, display name, thinking level, reasoning flag, context window, max tokens, and per-million input/output prices. Native authentication and transport are handled by Pi. The request has a 5-second timeout bounded by the run's remaining budget; no credentials or parent history are passed to the classifier. Candidates come from `/scoped-models` (`--models` or `enabledModels`) intersected with the authenticated models; without scoping, every authenticated model is a candidate. Scope pins such as `openai/*:high` restrict that model to the pinned level when supported. Thinking levels are enumerated with Pi's per-model support map, and models from the `llamacpp` and `llama.cpp` providers are excluded. A run always includes a "use agent defaults" option; Jev's answer is accepted at any confidence.

The routed pair runs as the first attempt, followed by the configured model and fallback chain with their configured thinking, without repeating a model that Jev already chose. Definitions, settings overrides, and the parent model are never modified. Missing classifier/authentication, more than 254 pairs, no candidates, classifier errors, timeouts, or an invalid answer produce a sanitized warning in the run report and lifecycle results, and the run uses configured defaults. Stopping a run or shutting down Pi while routing is pending aborts it instead of falling back. Answering a child's questions continues the same session without routing again. Reports and results record the effective session thinking level next to the model.

## Define an agent

Shipped definitions live in [`default-agents/`](./default-agents/) and are copied to `~/.config/agents/pi/` when that directory does not exist. Runtime reads, edits, creates, and renames only the copies in `~/.config/agents/pi/`; committed defaults stay untouched.

Create custom agents in that directory directly or press `c` in `/subagents`.

```md
---
name: scout
description: Fast read-only reconnaissance
model: openai-codex/gpt-5.6-luna
thinking: low
timeoutMs: 900000
skills: project-conventions, ponytail
tools: read, grep, find, ls
---
You are a fast codebase scout. Inspect only and return exact evidence.
```

Supported frontmatter is deliberately limited to `name`, `description`, `model`, `thinking`, `timeoutMs`, comma-separated `fallbackModels`, comma-separated `skills`, and comma-separated tools. Omit `model` to inherit the parent model. Set `fallbackModels: openai-codex/gpt-6-astra` for one fallback, or separate multiple models with commas. Settings overrides take precedence over frontmatter. Configure timeouts with `timeoutMs` in Markdown frontmatter or `settings.json`: an integer from 1 to 2147483647 milliseconds (for example, `1800000` for 30 minutes). Invalid Markdown values produce a diagnostic warning and are ignored; omitting the field means no total-runtime deadline. Only skills named on that agent are exposed to the child; Pi resolves them through its normal trusted global, project, package, and configured skill paths. Configured skills require the `read` tool, and a missing skill blocks the run. `pi-subagents` is always excluded because children cannot delegate. Children inherit project context files and the guardrails policy extension, but not the parent conversation, ambient skills, unrelated extensions, or session history; tasks must be self-contained. Claude Bridge attempts also load its installed extension from `git/github.com/elidickinson/pi-claude-bridge/src/index.ts` under Pi's agent directory so its hooks capture the child's own prompt and skills; copying the provider alone does not register those hooks. Their normal system prompt is preserved and the role prompt is appended, so tool and environment guidance stays consistent across providers.

Restoring defaults deletes the managed agent definitions and recopies `default-agents/*.md`. Configuration overrides in `settings.json` are not deleted. The shipped `diff-summarizer` is a cheap read-only orientation pass for the unstaged diff, staged diff, untracked files, tests, and review hotspots.

Every run immediately creates a Markdown report under `~/.config/agents/pi/reports/`, then atomically updates it on completion, failure, or abort. Every child attempt, including model fallbacks, uses a persistent JSONL session under `~/.config/agents/pi/subagent-sessions/`; all session paths are recorded in the report and exposed by run lifecycle tool results. The newest 200 completed reports are retained; active reports are never pruned.

## Check

```bash
(cd extensions/subagents && npm test)
node tests/subagents-decision-model.test.mjs
node tests/subagents-status.test.mjs
node tests/subagents-bridge.test.mjs
node tests/loop-with-goal.test.mjs
```

The decision model check exercises routing, cancellation, questionnaires, quiet-state/request capture, and same-child continuation across reload with a fake provider and no network access. Unit/status tests cover quiet timing, yellow rendering, selected-run controls, transcript/config validation and locks. The quiet UI never cancels a child. The bridge check exercises the actual subagent runner and Claude Bridge prompt capture offline, stopping before Claude Code starts. It requires the configured Bridge and guardrails packages to be installed. The goal loop check covers the lifecycle events, claims, and cancellation sources from the parent's side.
