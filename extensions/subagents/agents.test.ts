import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents, parseAgent } from "./agents.ts";
import {
  createAgentDefinition,
  deleteAgentDefinition,
  ensureDefaultAgents,
  renameAgentDefinition,
  replaceAgentBody,
  restoreDefaultAgents,
  withEffectiveSettings,
} from "./agent-files.ts";
import { acquireMutationLock, finishRunReport, startRunReport } from "./reports.ts";

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

  const agent = discoverAgents({ agentsDirectory, settingsPaths: [globalSettings, projectSettings] })[0];
  assert.equal(agent.description, "user");
  assert.equal(agent.model, undefined);
  assert.deepEqual(agent.fallbackModels, ["openai/fallback"]);
  assert.equal(agent.thinking, "high");

  const parsed = parseAgent(definition("reviewer", "read only"));
  assert.deepEqual(parsed?.tools, ["read", "grep"]);
  assert.equal(parsed?.thinking, "low");
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

test("locks mutation-capable async runs per working directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "lofi-subagent-locks-"));
  const release = acquireMutationLock(directory, process.cwd(), "first");
  assert.throws(() => acquireMutationLock(directory, process.cwd(), "second"), /already running/);
  release();
  const releaseAgain = acquireMutationLock(directory, process.cwd(), "second");
  releaseAgain();
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
