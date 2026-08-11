# Lazy-loaded subagents

Pi still loads the official `npm:pi-subagents` package at startup, but this directory keeps its model-facing tools out of the initial provider payload.

## Flow

1. `pi-subagents` registers `subagent`, `subagent_wait`, `subagent_supervisor`, and `intercom`.
2. [`index.ts`](./index.ts) deactivates those tools at session start, leaving only the small `load_subagents` tool visible.
3. When delegation is needed, the model calls `load_subagents`.
4. The loader activates all four tools. Models with native deferred tool loading, including GPT-5.6, receive their definitions on the next provider call without invalidating the initial tool-schema prefix.
5. The model calls `subagent` with `action: "list"`, selects an available agent, and launches work through `workflowScript`.
6. Subagent tools remain active for the rest of the session. A new, resumed, forked, reloaded, or restarted session hides them again.

For providers without native deferred loading, Pi falls back to sending the complete active tool list on the next request.

## Description

[`config.json`](./config.json) sets `toolDescriptionMode` to `custom`. The custom description lives at [`../../subagent-tool-description.md`](../../subagent-tool-description.md) and is included when the `subagent` tool becomes visible. `pi-subagents` always appends its mandatory safety guidance.

## Other behavior

Only provider-visible tool activation changes. Pi-subagents slash commands, background execution, result watching, and other extension machinery remain available while the tools are hidden.

## Savings

This shaves off around 23kb of initial context tokens (around 5.5k-7.5k give or take).
