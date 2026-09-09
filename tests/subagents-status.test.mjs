import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const requirePi = createRequire(join(globalRoot, "@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = await import(pathToFileURL(requirePi.resolve("jiti")).href);
const tuiPath = requirePi.resolve("@earendil-works/pi-tui");
const { visibleWidth } = await import(pathToFileURL(tuiPath).href);
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-tui": tuiPath } });
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
runs = [first, run("reviewer", "anthropic/second")];
status.handleInput("\x0e"); // Ctrl+n selects the next run.
assert.match(render().join("\n"), /Model: anthropic\/second/);
status.handleInput("\x10"); // Ctrl+p selects the previous run.
assert.match(render().join("\n"), /Model: openai\/fallback/);
for (const width of [20, 80, 160]) {
  lines = status.render(width);
  assert.equal(lines.length, 40);
  assert.ok(lines.every(line => visibleWidth(line) <= width));
}
console.log("subagents status test passed");
