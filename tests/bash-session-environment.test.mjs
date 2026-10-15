import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "..");
process.env.PI_CODING_AGENT_DIR = repo;
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works/pi-coding-agent");
const sdkPath = join(piRoot, "dist/index.js");
const { createBashTool } = await import(pathToFileURL(sdkPath).href);
const { createJiti } = await import(pathToFileURL(join(piRoot, "node_modules/jiti/lib/jiti.mjs")).href);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": sdkPath,
    "@earendil-works/pi-tui": join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  },
});
const display = join(repo, "npm/node_modules/pi-tool-display/src");
const { loadToolDisplayConfig } = await jiti.import(join(display, "config-store.ts"));
const { registerToolDisplayOverrides } = await jiti.import(join(display, "tool-overrides.ts"));
const { config, error } = loadToolDisplayConfig();
assert.equal(error, undefined);

// Exercise the installed display wrapper, not just the configuration value.
const tools = new Map([["bash", createBashTool(repo)]]);
registerToolDisplayOverrides({
  registerTool: (tool) => tools.set(tool.name, tool),
  getAllTools: () => [],
  on() {},
}, () => config);

const ctx = {
  cwd: repo,
  sessionManager: {
    getSessionId: () => "session-environment-test",
    getSessionFile: () => "/test/current-session.jsonl",
  },
  model: { provider: "test-provider", id: "test-model" },
  thinkingLevel: "high",
};
const command = 'printf "%s\\n" "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"';
const result = await tools.get("bash").execute("test", { command }, undefined, undefined, ctx);
assert.equal(result.content[0].text.trim(), [
  "session-environment-test",
  "/test/current-session.jsonl",
  "test-provider",
  "test-model",
  "high",
].join("\n"));

process.env.PI_SESSION_FILE = "/test/stale-parent.jsonl";
ctx.sessionManager.getSessionFile = () => undefined;
const ephemeral = await tools.get("bash").execute("ephemeral", {
  command: 'printf "%s" "${PI_SESSION_FILE-unset}"',
}, undefined, undefined, ctx);
assert.equal(ephemeral.content[0].text, "unset");
console.log("Bash session environment tests passed");
