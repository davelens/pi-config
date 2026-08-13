import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents, parseAgent } from "./agents.ts";
import {
  createAgentDefinition,
  deleteAgentDefinition,
  ensureDefaultAgents,
  renameAgentDefinition,
  renameAgentWithSettings,
  replaceAgentBody,
  restoreDefaultAgents,
  withEffectiveSettings,
} from "./agent-files.ts";
import { acquireMutationLock, finishRunReport, pruneRunReports, startRunReport } from "./reports.ts";
import { captureRunMessage, streamJump, trackRun, type RunMessage } from "./run-stream.ts";

const definition = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\ntools: read, grep\nthinking: low\n---\nBe useful.`;

test("parses definitions and applies settings overrides in order", () => {
  const root = mkdtempSync(join(tmpdir(), "lofi-subagents-"));
  const agentsDirectory = join(root, "agents");
  const globalSettings = join(root, "settings.json");
  const projectSettings = join(root, "project-settings.json");
  mkdirSync(agentsDirectory);
  writeFileSync(join(agentsDirectory, "scout.md"), definition("scout", "user"));
  writeFileSync(globalSettings, JSON.stringify({
    subagents: { agentOverrides: { scout: { model: "openai/test", fallbackModels: ["openai/fallback"] } } },
  }));
  writeFileSync(projectSettings, JSON.stringify({
    subagents: { agentOverrides: { scout: { model: null, thinking: "high" } } },
  }));

  const agent = discoverAgents({ agentsDirectory, settingsPaths: [globalSettings, projectSettings], projectSettingsPath: projectSettings })[0];
  assert.equal(agent.description, "user");
  assert.equal(agent.model, undefined);
  assert.deepEqual(agent.fallbackModels, ["openai/fallback"]);
  assert.equal(agent.thinking, "high");

  const parsed = parseAgent(definition("reviewer", "read only"));
  assert.deepEqual(parsed?.tools, ["read", "grep"]);
  assert.equal(parsed?.thinking, "low");
});

test("rejects unknown tools and project mutation escalation", () => {
  const root = mkdtempSync(join(tmpdir(), "lofi-subagent-tools-"));
  const agentsDirectory = join(root, "agents");
  const projectSettings = join(root, "project-settings.json");
  mkdirSync(agentsDirectory);
  writeFileSync(join(agentsDirectory, "scout.md"), definition("scout", "read only").replace("read, grep", "read, gerp"));
  writeFileSync(projectSettings, JSON.stringify({
    subagents: { agentOverrides: { scout: { tools: ["read", "gerp", "bash"], timeoutMs: 1234 } } },
  }));

  const agent = discoverAgents({ agentsDirectory, settingsPaths: [projectSettings], projectSettingsPath: projectSettings })[0];
  assert.deepEqual(agent.tools, ["read", "gerp"]);
  assert.deepEqual(agent.invalidTools, ["gerp"]);
  assert.equal(agent.timeoutMs, 1234);
  assert.match(agent.warnings?.[0] ?? "", /cannot grant mutation tools: bash/);
});

test("migrates unchanged legacy read-only agents in an existing directory", () => {
  const root = mkdtempSync(join(tmpdir(), "lofi-subagent-migration-"));
  const defaults = join(root, "defaults");
  const agents = join(root, "agents");
  mkdirSync(defaults);
  mkdirSync(agents);
  const currentScout = definition("scout", "default").replace("tools: read, grep", "tools: read, grep, find, ls");
  const currentReviewer = definition("reviewer", "default").replace("tools: read, grep", "tools: read, grep, find, ls, git_inspect");
  writeFileSync(join(defaults, "scout.md"), currentScout);
  writeFileSync(join(defaults, "reviewer.md"), currentReviewer);
  writeFileSync(join(agents, "scout.md"), currentScout.replace("tools: read, grep, find, ls", "tools: read, grep, find, ls, bash"));
  writeFileSync(join(agents, "reviewer.md"), currentReviewer.replace("tools: read, grep, find, ls, git_inspect", "tools: read, grep, find, ls, bash"));

  ensureDefaultAgents(defaults, agents);

  assert.equal(readFileSync(join(agents, "scout.md"), "utf8"), currentScout);
  assert.equal(readFileSync(join(agents, "reviewer.md"), "utf8"), currentReviewer);
});

test("seeds only a missing directory and restores defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "lofi-subagent-defaults-"));
  const defaults = join(root, "defaults");
  const agents = join(root, "managed", "agents");
  mkdirSync(defaults);
  writeFileSync(join(defaults, "scout.md"), definition("scout", "default"));

  ensureDefaultAgents(defaults, agents);
  assert.equal(existsSync(join(agents, "scout.md")), true);
  writeFileSync(join(agents, "custom.md"), definition("custom", "custom"));
  mkdirSync(join(agents, "reports"));
  writeFileSync(join(agents, "reports", "saved.md"), "saved report");
  ensureDefaultAgents(defaults, agents);
  assert.equal(existsSync(join(agents, "custom.md")), true);

  restoreDefaultAgents(defaults, agents);
  assert.equal(existsSync(join(agents, "scout.md")), true);
  assert.equal(existsSync(join(agents, "custom.md")), false);
  assert.equal(existsSync(join(agents, "reports", "saved.md")), true);
});

test("renders effective settings without changing the definition", () => {
  const content = `${definition("oracle", "second opinion").replace("thinking: low", "model: openai/old\nthinking: low")}\n`;
  const rendered = withEffectiveSettings(content, {
    description: "effective description",
    model: "claude-bridge/claude-fable-5",
    fallbackModels: ["openai/fallback"],
    thinking: "xhigh",
    tools: ["read", "bash"],
  });
  assert.match(rendered, /^description: "effective description"$/m);
  assert.match(rendered, /^model: "claude-bridge\/claude-fable-5"$/m);
  assert.match(rendered, /^fallbackModels: "openai\/fallback"$/m);
  assert.match(rendered, /^thinking: "xhigh"$/m);
  assert.match(rendered, /^tools: "read, bash"$/m);
  assert.match(withEffectiveSettings(content, { description: "", tools: [] }), /^description: ""$/m);
  assert.match(withEffectiveSettings(content, { description: "", tools: [] }), /^tools: "\[\]"$/m);
  assert.doesNotMatch(rendered, /openai\/old/);
});

test("persists a recoverable run report", () => {
  const directory = mkdtempSync(join(tmpdir(), "lofi-subagent-reports-"));
  const report = startRunReport(directory, "../../reviewer", "Review this", "/project");
  assert.equal(report.filePath.startsWith(`${directory}/`), true);
  assert.match(readFileSync(report.filePath, "utf8"), /Status: running/);
  finishRunReport(report, { status: "completed", model: "openai/test", output: "Looks good." });
  const content = readFileSync(report.filePath, "utf8");
  assert.match(content, /Status: completed/);
  assert.match(content, /## Report\n\nLooks good\./);
});

test("prunes old completed reports without removing active reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "lofi-subagent-report-retention-"));
  for (let index = 0; index < 3; index++) {
    const report = startRunReport(directory, "reviewer", index === 0 ? "Task contains\n- Status: running" : `Review ${index}`, "/project");
    finishRunReport(report, { status: "completed", output: "Done" });
  }
  const active = startRunReport(directory, "reviewer", "Still running", "/project");

  pruneRunReports(directory, 2);

  assert.equal(existsSync(active.filePath), true);
  assert.equal(readdirSync(directory).filter((name) => name.endsWith(".md")).length, 3);
});

test("locks all mutation-capable runs per working directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "lofi-subagent-locks-"));
  const release = acquireMutationLock(directory, process.cwd(), "first");
  assert.throws(() => acquireMutationLock(directory, join(process.cwd(), "default-agents"), "second"), /already running/);
  release();
  const releaseAgain = acquireMutationLock(directory, process.cwd(), "second");
  releaseAgain();
});

test("publishes only fully initialized writer locks", () => {
  const directory = mkdtempSync(join(tmpdir(), "lofi-subagent-lock-race-"));
  const release = acquireMutationLock(directory, process.cwd(), "first");
  const entries = readdirSync(join(directory, ".locks"));

  assert.equal(entries.length, 1);
  assert.equal(existsSync(join(directory, ".locks", entries[0]!, "owner.json")), true);
  release();
});

test("refuses unsafe stale writer-lock reclamation", () => {
  const directory = mkdtempSync(join(tmpdir(), "lofi-subagent-stale-lock-"));
  acquireMutationLock(directory, process.cwd(), "first");
  const lockName = readdirSync(join(directory, ".locks"))[0]!;
  writeFileSync(join(directory, ".locks", lockName, "owner.json"), JSON.stringify({ pid: 2 ** 30, runId: "first" }));

  assert.throws(() => acquireMutationLock(directory, process.cwd(), "second"), /stale writer lock/);
});

test("captures live messages and in-flight tool output", () => {
  const messages: RunMessage[] = [];
  captureRunMessage(messages, { type: "message_start", message: { role: "user", content: "Task" } });
  captureRunMessage(messages, { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Part" }] } });
  captureRunMessage(messages, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Partial" }] } });
  captureRunMessage(messages, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Complete" }] } });
  captureRunMessage(messages, { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "printf hi" } });
  captureRunMessage(messages, { type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "h" }] } });
  captureRunMessage(messages, { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: "hi" }] }, isError: false });

  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1]?.content, [{ type: "text", text: "Complete" }]);
  assert.deepEqual(messages[2], {
    role: "toolExecution",
    toolCallId: "tool-1",
    toolName: "bash",
    content: [{ type: "text", text: "hi" }],
    isError: false,
    status: "completed",
  });
});

test("maps stream jump keys", () => {
  assert.deepEqual(streamJump("g", false), { pendingG: true });
  assert.deepEqual(streamJump("g", true), { jump: "top", pendingG: false });
  assert.deepEqual(streamJump("G", false), { jump: "bottom", pendingG: false });
  assert.deepEqual(streamJump("}", false), { jump: 10, pendingG: false });
  assert.deepEqual(streamJump("{", false), { jump: -10, pendingG: false });
});

test("tracks foreground runs and forwards cancellation", () => {
  const directory = mkdtempSync(join(tmpdir(), "lofi-subagent-foreground-"));
  const report = startRunReport(directory, "reviewer", "Review this", "/project");
  const runs = new Map();
  const parent = new AbortController();
  const run = trackRun(runs, report, parent.signal, false);

  assert.equal(runs.get(report.id), run);
  parent.abort();
  assert.equal(run.signal.aborted, true);
});

test("preflights every settings override before renaming an agent", () => {
  const directory = mkdtempSync(join(tmpdir(), "lofi-subagent-rename-"));
  const source = join(directory, "reviewer.md");
  const firstSettings = join(directory, "global.json");
  const conflictingSettings = join(directory, "project.json");
  writeFileSync(source, definition("reviewer", "Review code"));
  writeFileSync(firstSettings, JSON.stringify({ subagents: { agentOverrides: { reviewer: { thinking: "high" } } } }));
  writeFileSync(conflictingSettings, JSON.stringify({ subagents: { agentOverrides: { reviewer: {}, auditor: {} } } }));
  const originalSettings = readFileSync(firstSettings, "utf8");

  assert.throws(() => renameAgentWithSettings(source, [firstSettings, conflictingSettings], "reviewer", "auditor"), /already exists/);
  assert.equal(existsSync(source), true);
  assert.equal(existsSync(join(directory, "auditor.md")), false);
  assert.equal(readFileSync(firstSettings, "utf8"), originalSettings);
});

test("default read-only agents are not mutation-capable", () => {
  for (const name of ["scout", "reviewer", "oracle", "researcher"]) {
    const agent = parseAgent(readFileSync(join(import.meta.dirname, "default-agents", `${name}.md`), "utf8"));
    assert.deepEqual(agent?.tools.filter((tool) => ["bash", "edit", "write"].includes(tool)), []);
  }
  const reviewer = parseAgent(readFileSync(join(import.meta.dirname, "default-agents", "reviewer.md"), "utf8"));
  const researcher = parseAgent(readFileSync(join(import.meta.dirname, "default-agents", "researcher.md"), "utf8"));
  assert.equal(reviewer?.tools.includes("git_inspect"), true);
  assert.equal(researcher?.tools.includes("ketch"), true);
});

test("creates, edits, and renames agent definition files", () => {
  const directory = mkdtempSync(join(tmpdir(), "lofi-subagent-manager-"));
  const created = createAgentDefinition(directory, "release-reviewer");
  const updated = replaceAgentBody(readFileSync(created, "utf8"), "Review releases only.");
  writeFileSync(created, updated);
  const renamed = renameAgentDefinition(created, "deploy-reviewer");

  assert.equal(existsSync(created), false);
  assert.match(readFileSync(renamed, "utf8"), /^name: deploy-reviewer$/m);
  assert.match(readFileSync(renamed, "utf8"), /Review releases only\./);
  deleteAgentDefinition(renamed);
  assert.equal(existsSync(renamed), false);
});
