import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const requirePi = createRequire(join(globalRoot, "@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = await import(pathToFileURL(requirePi.resolve("jiti")).href);
const tuiPath = requirePi.resolve("@earendil-works/pi-tui");
const { visibleWidth } = await import(pathToFileURL(tuiPath).href);
const piPath = join(globalRoot, "@earendil-works/pi-coding-agent/dist/index.js");
const { SessionManager } = await import(pathToFileURL(piPath).href);
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-tui": tuiPath, "@earendil-works/pi-coding-agent": piPath } });
const { SubagentStatus } = await jiti.import(new URL("../extensions/subagents/status.ts", import.meta.url).pathname);
const run = (agent, model) => ({
  report: { agent, model, status: "running", id: "12345678" },
  messages: [{ role: "assistant", content: "Live output\n".repeat(60) }],
});
const first = run("scout");
let runs = [first];
const status = new SubagentStatus({
  tui: { terminal: { rows: 40 }, requestRender() {} },
  theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text },
  runs: () => runs,
  done() {},
});
const render = () => status.render(160).map(stripVTControlCharacters);
assert.match(render().join("\n"), /Model: starting…/);
first.report.model = "openai/primary";
let lines = render();
assert.ok(lines.findIndex(line => line.includes("Model: openai/primary")) < lines.findIndex(line => line.includes("Live output")));
status.handleInput("g");
status.handleInput("g");
assert.match(render().join("\n"), /Model: openai\/primary/);
first.report.model = "openai/fallback";
assert.match(render().join("\n"), /Model: openai\/fallback/);
assert.doesNotMatch(render().join("\n"), /Thinking:/);
first.report.thinking = "low";
assert.match(render().join("\n"), /Model: openai\/fallback · Thinking: low/);
runs = [first, run("reviewer", "anthropic/second")];
status.handleInput("\x0e"); // Ctrl+n selects the next run.
assert.match(render().join("\n"), /Model: anthropic\/second/);
status.handleInput("\x10"); // Ctrl+p selects the previous run.
assert.match(render().join("\n"), /Model: openai\/fallback/);
first.report.warnings = ["Watchdog suspects repeated tool cycle"];
first.report.error = "Subagent stopped after persistent repeated tool cycle stall";
status.handleInput("l");
status.handleInput("G");
assert.match(render().join("\n"), /Watchdog suspects repeated tool cycle/);
assert.match(render().join("\n"), /Subagent stopped after persistent repeated tool cycle stall/);
for (const width of [20, 80, 160]) {
  lines = status.render(width);
  assert.equal(lines.length, 40);
  assert.ok(lines.every(line => visibleWidth(line) <= width));
}
// Quiet color is informational, turns on without new messages, and exposes request/tool inspection.
const { newActivity, observeActivity, QUIET_MS } = await jiti.import(new URL("../extensions/subagents/activity.ts", import.meta.url).pathname);
let now = 0;
const colors = [];
const quietRun = run("worker", "fake/model");
quietRun.report.filePath = "/unavailable/report.md";
quietRun.activity = newActivity(now);
observeActivity(quietRun.activity, { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "investigate.ts" } }, now);
const actions = [];
let uiRuns = [quietRun];
const quietStatus = new SubagentStatus({
  tui: { terminal: { rows: 40 }, requestRender() {} },
  theme: { fg: (color, text) => { colors.push([color, text]); return text; }, bg: (_color, text) => text, bold: text => text },
  runs: () => uiRuns, now: () => now, done() {},
  cancel: async (id) => { actions.push(["cancel", id]); quietRun.report.status = "aborted"; quietRun.report.checkpoint = {}; },
  continue: async (id) => { actions.push(["continue", id]); const next = run("continued", "fake/model"); next.report.id = "continued-id"; uiRuns.push(next); return { details: { run: next.report } }; },
});
assert.doesNotMatch(quietStatus.render(160).join("\n"), /silent/);
now = QUIET_MS;
const quietOutput = quietStatus.render(160).join("\n");
assert.match(quietOutput, /silent 5m/);
assert.match(quietOutput, /LAST MODEL-REQUEST CONTEXT/);
assert.match(quietOutput, /investigate.ts/);
assert.ok(colors.some(([color, text]) => color === "warning" && text.includes("worker · silent")));
assert.match(quietOutput, /c cancel/);
observeActivity(quietRun.activity, { type: "tool_execution_update", toolCallId: "read" }, now);
assert.doesNotMatch(quietStatus.render(160).join("\n"), /silent/);
const unrelated = run("other", "fake/model");
unrelated.report.id = "other-id";
uiRuns.push(unrelated);
quietStatus.handleInput("c");
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(actions, [["cancel", "12345678"]]);
assert.match(quietStatus.render(160).join("\n"), /r continue/);
quietStatus.handleInput("r");
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(actions[1], ["continue", "12345678"]);
assert.match(quietStatus.render(160).join("\n"), /continued/);
for (const width of [20, 80, 160]) assert.ok(quietStatus.render(width).every(line => visibleWidth(line) <= width));

const failureStatus = new SubagentStatus({
  tui: { terminal: { rows: 40 }, requestRender() {} },
  theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text },
  runs: () => [run("worker", "fake/model")], done() {},
  cancel: async () => { throw new Error("Cancellation failed visibly"); },
});
failureStatus.handleInput("c");
await new Promise(resolve => setImmediate(resolve));
assert.match(failureStatus.render(160).join("\n"), /Cancellation failed visibly/);

// Saved history survives a new SessionManager and includes abandoned branches.
const { HISTORY_ENTRY, loadRunHistory } = await jiti.import(new URL("../extensions/subagents/history.ts", import.meta.url).pathname);
const root = mkdtempSync(new URL("../.subagent-history-test-", import.meta.url).pathname);
try {
  const parent = SessionManager.create(root, root);
  const branchPoint = parent.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  parent.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });
  const child = join(root, "child.jsonl");
  const assistant = { role: "assistant", content: [{ type: "text", text: "Saved child answer" }], usage: { input: 42, output: 7, cost: { total: 0.1 } } };
  writeFileSync(child, [
    { type: "session", version: 3, id: "child", cwd: root, timestamp: new Date().toISOString() },
    { type: "message", message: { role: "user", content: "Original task" } },
    { type: "message", message: assistant },
  ].map(JSON.stringify).join("\n"));
  const report = { id: "saved", agent: "scout", task: "Original task", cwd: root, startedAt: new Date().toISOString(), status: "running", filePath: join(root, "pruned.md"), sessionPaths: [] };
  const save = (report) => parent.appendCustomEntry(HISTORY_ENTRY, { parentSessionId: parent.getSessionId(), report: structuredClone(report) });
  save(report);
  save({ ...report, status: "completed", output: "Saved child answer", sessionPaths: [child] });
  parent.branch(branchPoint);
  parent.appendMessage({ role: "user", content: "Different branch", timestamp: Date.now() });
  assert.equal(parent.getBranch().some((entry) => entry.customType === HISTORY_ENTRY), false);
  const reopened = SessionManager.open(parent.getSessionFile());
  let history = loadRunHistory(reopened, new Map());
  assert.equal(history.length, 1, "deduplicated across all branches after reopening");
  assert.equal(history[0].report.status, "completed");
  assert.deepEqual(history[0].messages.at(-1), assistant, "restores the transcript and usage without the Markdown report");
  assert.deepEqual(loadRunHistory(SessionManager.inMemory(root), new Map()), [], "same cwd is not the same session");
  const fork = SessionManager.inMemory(root);
  for (const entry of parent.getEntries().filter((entry) => entry.customType === HISTORY_ENTRY)) fork.appendCustomEntry(HISTORY_ENTRY, entry.data);
  assert.deepEqual(loadRunHistory(fork, new Map()), [], "forked copies retain their original parent session identity");

  rmSync(child);
  history = loadRunHistory(reopened, new Map());
  assert.match(JSON.stringify(history[0].messages), /Child transcript unavailable/);
  assert.match(JSON.stringify(history[0].messages), /Saved child answer/);
  writeFileSync(child, "not a transcript");
  assert.match(JSON.stringify(loadRunHistory(reopened, new Map())[0].messages), /Child transcript unavailable/);

  save({ ...report, id: "interrupted", status: "waiting" });
  history = loadRunHistory(parent, new Map());
  assert.equal(history.at(-1).report.status, "aborted");
  assert.match(history.at(-1).report.error, /Interrupted/);
  assert.equal(parent.getEntries().at(-1).data.report.status, "waiting", "display normalization does not mutate persisted state");
  const active = { report: { ...report, id: "interrupted", status: "waiting" }, messages: [] };
  assert.equal(loadRunHistory(parent, new Map([["interrupted", active]])).at(-1), active, "a genuinely live run is not marked interrupted");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("subagents status and history tests passed");
