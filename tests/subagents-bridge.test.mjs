import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(repo, ".subagents-bridge-test-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "pi");
process.env.HOME = root;
process.env.TMPDIR = root;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.NODE_DISABLE_COMPILE_CACHE = "1";
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(root, "bridge.log");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works/pi-coding-agent");
let session;
try {
  const { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), "{}");
  symlinkSync(join(repo, "npm"), join(agentDir, "npm"), "dir");
  symlinkSync(join(repo, "git"), join(agentDir, "git"), "dir");
  const bridgePath = join(agentDir, "git/github.com/elidickinson/pi-claude-bridge/src/index.ts");
  writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ askClaude: { enabled: false }, provider: { plan: "max" } }));
  writeFileSync(join(root, "AGENTS.md"), "CHILD_PROJECT_CONTEXT\n");
  const skillDirectory = join(agentDir, "skills", "child-skill");
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: child-skill\ndescription: CHILD_SKILL_DESCRIPTION\n---\nChild skill instructions.\n");
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "claude-bridge",
    defaultModel: "claude-fable-5",
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [bridgePath, join(repo, "extensions/subagents/index.ts")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => "PARENT_ONLY_INSTRUCTIONS",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(root),
    tools: ["read"],
  }));
  const registry = new ModelRegistry(runtime);
  const config = registry.getRegisteredProviderConfig("claude-bridge");
  assert.ok(config?.streamSimple);
  const boundary = new Error("Stopped before Claude Code subprocess creation");
  const prompts = [];
  const toolSets = [];
  runtime.registerProvider("claude-bridge", {
    ...config,
    streamSimple(model, context, options) {
      // Exercise the real bridge capture/projection, but never start Claude Code.
      assert.throws(() => config.streamSimple(model, context, {
        ...options,
        get cwd() { throw boundary; },
      }), (error) => error === boundary);
      prompts.push(context.systemPrompt);
      toolSets.push(context.tools.map((tool) => tool.name));
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant", content: [{ type: "text", text: "CAPTURE_OK" }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  });
  await session.setModel(registry.find("claude-bridge", "claude-fable-5"));
  await session.prompt("Seed the parent capture without calling an API.");
  assert.equal(prompts.length, 1, "parent prompt capture must work before checking the child");
  const managed = join(root, ".config/agents/pi");
  writeFileSync(join(managed, "oracle.md"), "---\nname: oracle\ndescription: Test oracle\nmodel: claude-bridge/claude-fable-5\nskills: child-skill\ntools: read\n---\nCHILD_ROLE_INSTRUCTIONS\n");
  const subagents = loader.getExtensions().extensions.find((extension) => extension.tools.has("subagent"));
  const tool = subagents.tools.get("subagent").definition;
  const result = await tool.execute("bridge-check", { action: "run", agent: "oracle", task: "Check child prompt capture." }, new AbortController().signal, undefined, {
    cwd: root, modelRegistry: registry, model: session.model, isProjectTrusted: () => false,
  });
  assert.match(result.content[0].text, /CAPTURE_OK/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /CHILD_ROLE_INSTRUCTIONS/);
  assert.match(prompts[1], /CHILD_PROJECT_CONTEXT/);
  assert.match(prompts[1], /CHILD_SKILL_DESCRIPTION/);
  assert.doesNotMatch(prompts[1], /PARENT_ONLY_INSTRUCTIONS/);
  assert.deepEqual(toolSets[1].sort(), ["contact_parent", "read"]);
  await session.prompt("Verify the parent still captures its own prompt after the child.");
  assert.equal(prompts.length, 3);
  assert.match(prompts[2], /PARENT_ONLY_INSTRUCTIONS/);
  assert.doesNotMatch(prompts[2], /CHILD_ROLE_INSTRUCTIONS|CHILD_SKILL_DESCRIPTION/);
  console.log("subagents bridge test passed (no API calls)");
} finally {
  session?.dispose();
}
