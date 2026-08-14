# Lo-fi subagents

A small replacement for `pi-subagents`: one foreground tool, in-process Pi SDK sessions, and Markdown agent definitions.

## Use

```text
subagent({ action: "list" })
subagent({ action: "run", agent: "scout", task: "Trace the login flow." })
subagent({ action: "run", agent: "reviewer", task: "Review the diff.", async: true })
subagent({ action: "resume", runId: "...", answer: "Use option B." })
subagent({ action: "status" })
subagent({ action: "stop", runId: "..." })
```

Pi already executes sibling tool calls concurrently, so parallel foreground work is multiple `subagent` calls in one turn. Broad implementation work is planned as independently verifiable slices and assigned to sequential workers; implementation and focused tests stay in the same slice. Each slice runs once, and retries or additional validation agents require an explicit user request. Every child is instructed to return only the requested deliverable and blockers, concisely, then stop. Every child also gets `contact_parent`: a blocking question pauses its in-memory session, returns the questions to the parent, and keeps writer locks held. The parent answers from established context or uses `ask_user_question`, then resumes the same run with `action: "resume"`. Async questions wake the idle parent through a follow-up message. Paused runs survive until completion, stop, reload, session replacement, or process exit; they are not durable across Pi restarts. Set `async: true` to return immediately while a child continues in-process. Async runs last until their task finishes or the current Pi session exits, reloads, or is replaced; shutdown aborts them gracefully. Only one mutation-capable agent (one with `bash`, `edit`, or `write`) can run per Git worktree (or working directory outside Git), whether foreground or async. Shipped read-only agents omit unrestricted `bash`, so they can run concurrently. The reviewer gets `git_inspect`, limited to read-only diff, log, and status operations; the researcher gets a shell-free `ketch` tool with an allowlist of supported CLI flags. Every child loads the configured guardrails policy extension and has a 15-minute default wall-clock timeout.

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

Run `/subagents-status` while at least one subagent is active to inspect every run started in the current Pi process, including foreground runs and completed siblings. The popup follows the latest message by default; use `j`/`k` to scroll, `{`/`}` to jump ten rows, `gg`/`G` to jump to the top/bottom, and `ctrl+n`/`ctrl+p` or the sidebar to switch runs. A single run uses the full panel without a sidebar. If nothing is running, Pi shows an inline message instead of opening the popup.

Run `/subagents-doctor` for the same style of scrollable popup covering malformed definitions, unavailable models, invalid tools, configured or missing skills, Pi skill diagnostics, guardrails, and active runs.

The deliberately awkward restore shortcut is shown in the footer so it remains discoverable without being easy to trigger accidentally. The manager shows save/error feedback in its footer. All editable agents live in `~/.config/agents/pi/`.

## Configure agents

Override bundled or custom agents in global `settings.json`, or in a trusted project's `.pi/settings.json`:

```json
{
  "subagents": {
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

Project settings override global settings. Supported overrides are `description`, `model`, `fallbackModels`, `thinking`, `timeoutMs`, `skills`, and `tools`. Set `model` to `null` to inherit the parent model. `skills` is an array of Pi skill names. A project override cannot grant `bash`, `edit`, or `write` to an agent whose effective global definition lacks that tool. Unsupported tool names are reported and block the run instead of being silently ignored. Overrides only configure an agent that has a Markdown definition; they do not define its prompt. `/subagents` renders these effective values in the file view without changing the Markdown file.

## Define an agent

Shipped definitions live in [`default-agents/`](./default-agents/) and are copied to `~/.config/agents/pi/` when that directory does not exist. Runtime reads, edits, creates, and renames only the copies in `~/.config/agents/pi/`; committed defaults stay untouched.

Create custom agents in that directory directly or press `c` in `/subagents`.

```md
---
name: scout
description: Fast read-only reconnaissance
model: openai-codex/gpt-5.6-luna
thinking: low
skills: project-conventions, ponytail
tools: read, grep, find, ls
---
You are a fast codebase scout. Inspect only and return exact evidence.
```

Supported frontmatter is deliberately limited to `name`, `description`, `model`, `thinking`, comma-separated `skills`, and comma-separated tools. Omit `model` to inherit the parent model. Configure fallbacks and timeouts through `settings.json`. Only skills named on that agent are exposed to the child; Pi resolves them through its normal trusted global, project, package, and configured skill paths. Configured skills require the `read` tool, and a missing skill blocks the run. `pi-subagents` is always excluded because children cannot delegate. Children inherit project context files and the guardrails policy extension, but not the parent conversation, ambient skills, other extensions, or session history; tasks must be self-contained. Their normal system prompt is preserved and the role prompt is appended, so tool and environment guidance stays consistent across providers.

Restoring defaults deletes the managed agent definitions and recopies `default-agents/*.md`. Configuration overrides in `settings.json` are not deleted. The shipped `diff-summarizer` is a cheap read-only orientation pass for the unstaged diff, staged diff, untracked files, tests, and review hotspots.

Every run immediately creates a Markdown report under `~/.config/agents/pi/reports/`, then atomically updates it on completion, failure, or abort. Foreground output links to the full report, and async `status` returns report paths. The newest 200 completed reports are retained; active reports are never pruned.

## Check

```bash
cd extensions/subagents && npm test
```
