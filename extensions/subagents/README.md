# Lo-fi subagents

A small replacement for `pi-subagents`: one foreground tool, in-process Pi SDK sessions, and Markdown agent definitions.

## Use

```text
subagent({ action: "list" })
subagent({ action: "run", agent: "scout", task: "Trace the login flow." })
subagent({ action: "run", agent: "reviewer", task: "Review the diff.", async: true })
subagent({ action: "status" })
subagent({ action: "stop", runId: "..." })
```

Pi already executes sibling tool calls concurrently, so parallel foreground work is multiple `subagent` calls in one turn. Set `async: true` to return immediately while a child continues in-process. Async runs last until their task finishes or the current Pi session exits, reloads, or is replaced; shutdown aborts them gracefully. Only one mutation-capable async agent (one with `bash`, `edit`, or `write`) can run per working directory.

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
- `esc` closes the manager.

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
        "fallbackModels": ["claude-bridge/claude-fable-5"],
        "tools": ["read", "grep", "find", "ls", "bash"]
      }
    }
  }
}
```

Project settings override global settings. Supported overrides are `description`, `model`, `fallbackModels`, `thinking`, and `tools`. Set `model` to `null` to inherit the parent model. Overrides only configure an agent that has a Markdown definition; they do not define its prompt. `/subagents` renders these effective values in the file view without changing the Markdown file.

## Define an agent

Shipped definitions live in [`default-agents/`](./default-agents/) and are copied to `~/.config/agents/pi/` when that directory does not exist. Runtime reads, edits, creates, and renames only the copies in `~/.config/agents/pi/`; committed defaults stay untouched.

Create custom agents in that directory directly or press `c` in `/subagents`.

```md
---
name: scout
description: Fast read-only reconnaissance
model: openai-codex/gpt-5.6-luna
thinking: low
tools: read, grep, find, ls, bash
---
You are a fast codebase scout. Inspect only and return exact evidence.
```

Supported frontmatter is deliberately limited to `name`, `description`, `model`, `thinking`, and comma-separated built-in `tools`. Omit `model` to inherit the parent model. Configure fallbacks through `settings.json`. Children inherit project context files, but not the parent conversation, skills, extensions, or session history; tasks must be self-contained.

Restoring defaults deletes the managed agent definitions and recopies `default-agents/*.md`. Configuration overrides in `settings.json` are not deleted.

Every run immediately creates a Markdown report under `~/.config/agents/pi/reports/`, then atomically updates it on completion, failure, or abort. Foreground output links to the full report, and async `status` returns report paths.

## Check

```bash
cd extensions/subagents && npm test
```
