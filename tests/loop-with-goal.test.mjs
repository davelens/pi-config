import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(repo, ".loop-with-goal-test-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "pi");
process.env.HOME = root;
process.env.TMPDIR = root;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.NODE_DISABLE_COMPILE_CACHE = "1";
delete process.env.TYPESAFE_API_KEY;
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works/pi-coding-agent");
const { createJiti } = await import(pathToFileURL(join(piRoot, "node_modules/jiti/lib/jiti.mjs")).href);
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-ai": join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  "@earendil-works/pi-tui": join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
  typebox: join(piRoot, "node_modules/typebox/build/index.mjs"),
} });
const state = await jiti.import(join(repo, "extensions/loop-with-goal/state.ts"));
const { goalWidgetLines } = await jiti.import(join(repo, "extensions/loop-with-goal/index.ts"));
const { visibleWidth, setKeybindings } = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
const { KeybindingsManager } = await import(pathToFileURL(join(piRoot, "dist/core/keybindings.js")).href);
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Network access is not allowed in this test"); };
const GOAL = "loop-with-goal";

// Pure state: reconstruction, ledger authority, failure classes, backoff.
{
  const custom = (customType, data) => ({ type: "custom", customType, data });
  const goal = state.createGoal("Ship it");
  assert.equal(state.reconstructGoal([], []), undefined);
  assert.deepEqual(state.reconstructGoal([custom(GOAL, goal)], []), goal);
  assert.equal(state.reconstructGoal([custom(GOAL, goal), custom(GOAL, { version: 1, goalId: goal.goalId, cleared: true })], []), undefined, "tombstone clears");
  assert.equal(state.reconstructGoal([custom(GOAL, goal), custom(GOAL, { version: 1, text: 42 })], []), undefined, "malformed snapshot fails safe");
  const pause = custom("loop-with-goal-control", { version: 1, goalId: goal.goalId, action: "pause", source: "interrupt", at: "now" });
  const resume = custom("loop-with-goal-control", { version: 1, goalId: goal.goalId, action: "resume", source: "command", at: "later" });
  assert.equal(state.reconstructGoal([custom(GOAL, goal)], [pause]).paused, true, "ledger pause applies to an earlier active snapshot");
  assert.equal(state.reconstructGoal([custom(GOAL, goal)], [pause, resume]).paused, false);
  assert.equal(state.reconstructGoal([custom(GOAL, { ...goal, paused: true })], [pause, resume]).paused, false, "latest user control wins");
  assert.equal(state.reconstructGoal([custom(GOAL, goal)], [custom("loop-with-goal-control", { version: 1, goalId: "other", action: "pause", source: "command", at: "x" })]).paused, false, "other goals' controls are ignored");
  assert.equal(state.classifyFailure("503 Service Unavailable"), "transient");
  assert.equal(state.classifyFailure("socket hang up"), "transient");
  assert.equal(state.classifyFailure("401 Unauthorized: invalid api key"), "permanent");
  assert.equal(state.classifyFailure("insufficient_quota"), "permanent");
  assert.equal(state.classifyFailure(undefined), "permanent");
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(state.backoffMs), [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.throws(() => state.validateEvidence("done"), /at least 20 characters/);
}

// Widget rendering fits narrow and wide terminals with wide characters, without theme leaks.
{
  const theme = { fg: (_color, text) => `\x1b[31m${text}\x1b[0m` };
  const view = { state: "active", text: "實作循環目標並驗證每一項驗收標準 with a long tail that must truncate", detail: "retry 1/10 in 5s" };
  for (const width of [8, 20, 41, 120]) {
    const lines = goalWidgetLines(view, theme, width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width, `fits ${width}`);
  }
  assert.match(goalWidgetLines({ state: "paused", text: "x", detail: "interrupt — /goal resume" }, theme, 80)[0], /paused.*\/goal resume/);
}

// The actual runner with a fake provider, bound UI, and synthetic long timers.
let session;
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
const timers = new Map();
globalThis.setTimeout = (callback, delay, ...args) => {
  // Short timers (native retry sleeps) and the questionnaire's 2s prewarm run for real; the supervisor's delays are captured.
  if (!(delay >= 1000) || delay === 2000) return realSet(callback, delay, ...args);
  const handle = { delay, unref() { return this; }, ref() { return this; } };
  timers.set(handle, () => callback(...args));
  return handle;
};
globalThis.clearTimeout = (handle) => { if (!timers.delete(handle)) realClear(handle); };
const pendingDelays = () => [...timers.keys()].map(({ delay }) => delay);
const fire = (delay) => {
  const entry = [...timers].find(([handle]) => handle.delay === delay);
  assert.ok(entry, `expected a pending ${delay}ms timer, have ${pendingDelays()}`);
  timers.delete(entry[0]);
  entry[1]();
};
try {
  const { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), "{}");
  symlinkSync(join(repo, "npm"), join(agentDir, "npm"), "dir");
  setKeybindings(KeybindingsManager.create(agentDir));
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 5 }, compaction: { enabled: false, keepRecentTokens: 1 } });
  const extensionPaths = [join(repo, "extensions/loop-with-goal/index.ts"), join(repo, "extensions/subagents/index.ts"), join(repo, "npm/node_modules/@juicesharp/rpiv-ask-user-question/index.ts")];
  const makeLoader = async () => {
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, additionalExtensionPaths: extensionPaths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    return loader;
  };
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const streams = [];
  let script = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const modelDefinition = (id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 });
  runtime.registerProvider("fake", {
    apiKey: "fake-key",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9",
    models: [modelDefinition("cheap")],
    streamSimple(model, context, options) {
      const step = script.shift() ?? { text: "UNSCRIPTED" };
      streams.push({ messages: context.messages, step });
      const stream = createAssistantMessageEventStream();
      const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
      if (step.hold) {
        step.started = true;
        const end = (stopReason, errorMessage) => {
          const message = { ...base, content: [], stopReason, errorMessage };
          stream.push({ type: "error", reason: stopReason, error: message });
          stream.end(message);
        };
        step.fail = (errorMessage) => end("error", errorMessage);
        options.signal.addEventListener("abort", () => end("aborted", "Operation aborted"), { once: true });
        return stream;
      }
      if (step.error) {
        const message = { ...base, content: [], stopReason: "error", errorMessage: step.error };
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
        return stream;
      }
      const message = step.toolCall
        ? { ...base, content: [{ type: "toolCall", id: `call-${streams.length}`, name: step.toolCall.name, arguments: step.toolCall.arguments }], stopReason: "toolUse" }
        : { ...base, content: [{ type: "text", text: step.text }], stopReason: "stop" };
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    },
  });
  await runtime.getAvailable();
  const registry = new ModelRegistry(runtime);
  const cheap = registry.find("fake", "cheap");
  assert.ok(cheap);
  writeFileSync(join(root, "fixture.txt"), "fixture\n");
  const managed = join(root, ".config/agents/pi");
  mkdirSync(managed, { recursive: true });
  writeFileSync(join(managed, "oracle.md"), "---\nname: oracle\ndescription: Test oracle\nmodel: fake/cheap\ntools: read\n---\nAnswer briefly.\n");

  const notices = [];
  const uiCalls = [];
  let inputHandler;
  let widgetFactory;
  let answer = () => ({ answers: [], cancelled: true });
  const theme = { fg: (_color, text) => String(text) };
  const uiContext = {
    notify: (message, level) => notices.push(`${level}: ${message}`),
    onTerminalInput: (handler) => { inputHandler = handler; return () => { if (inputHandler === handler) inputHandler = undefined; }; },
    setWidget: (key, content, options) => { uiCalls.push(["setWidget", key, options?.placement]); widgetFactory = typeof content === "function" ? content : undefined; },
    setHeader: () => uiCalls.push(["setHeader"]),
    setEditorComponent: () => uiCalls.push(["setEditorComponent"]),
    getEditorComponent: () => undefined,
    setStatus() {}, setWorkingMessage() {}, setTitle() {},
    custom: async () => answer(),
    select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
    theme,
  };
  const bind = (target) => target.bindExtensions({
    uiContext, mode: "tui",
    commandContextActions: {
      waitForIdle: () => target.waitForIdle(),
      navigateTree: (id, options) => target.navigateTree(id, options),
      newSession: async () => ({ cancelled: false }), fork: async () => ({ cancelled: false }), switchSession: async () => ({ cancelled: false }), reload: async () => {},
    },
  });
  const open = async (sessionManager) => {
    const loader = await makeLoader();
    const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, modelRuntime: runtime, model: cheap, sessionManager, tools: ["read", "goal_control", "ask_user_question", "subagent"] });
    await bind(session);
    const extension = loader.getExtensions().extensions.find((candidate) => candidate.commands.has("goal"));
    const subagents = loader.getExtensions().extensions.find((candidate) => candidate.tools.has("subagent"));
    return { session, extension, subagents, subagentTool: subagents.tools.get("subagent").definition };
  };
  const settle = (ms = 20) => new Promise((resolve) => realSet(resolve, ms));
  const until = async (condition, label = "condition") => {
    for (let i = 0; i < 200 && !condition(); i++) await settle(5);
    assert.ok(condition(), `expected ${label}`);
  };
  const nextSettled = (target) => new Promise((resolve) => {
    const unsubscribe = target.subscribe((event) => { if (event.type === "agent_settled") { unsubscribe(); resolve(event); } });
  });
  const nextRetry = (target) => new Promise((resolve) => {
    const unsubscribe = target.subscribe((event) => { if (event.type === "auto_retry_start") { unsubscribe(); resolve(event); } });
  });
  const lastGoal = (target) => state.reconstructGoal(target.sessionManager.getBranch(), target.sessionManager.getEntries());
  const goalMessages = (target) => target.messages.filter((message) => message.role === "custom" && message.customType === GOAL);
  const contextOf = (index) => JSON.stringify(streams[index].messages);
  const done = (evidence = "All criteria verified: tests pass and files exist") => ({ toolCall: { name: "goal_control", arguments: { action: "done", evidence } } });
  const read = { toolCall: { name: "read", arguments: { path: "fixture.txt" } } };
  const status = async (opened) => { const before = notices.length; await opened.session.prompt("/goal status"); return notices.slice(before).join("\n"); };
  const escape = () => inputHandler?.("\x1b");

  let opened = await open(SessionManager.create(root, root));
  ({ session } = opened);
  assert.ok(uiCalls.every(([name]) => name !== "setHeader" && name !== "setEditorComponent"), "header and editor are untouched");
  assert.equal(widgetFactory, undefined, "no goal, no widget");

  // 1. No goal: an ordinary stop stays stopped.
  script = [{ text: "HELLO" }];
  await session.prompt("hi");
  await session.waitForIdle();
  assert.equal(streams.length, 1);
  assert.deepEqual(goalMessages(session), []);
  assert.deepEqual(pendingDelays(), []);

  // 2. Activation persists, a stop continues, evidence-based done ends the loop.
  script = [read, { text: "I think that's it." }, done(), { text: "Finished." }];
  let settled = nextSettled(session);
  await session.prompt("/goal Verify fixture.txt exists and report");
  await settled;
  assert.equal(streams.length, 5);
  assert.match(contextOf(1), /Pinned goal \(stays active/);
  assert.match(contextOf(3), /\[loop-with-goal\] You stopped, but the goal has not been reported done/);
  assert.equal(lastGoal(session).status, "done");
  assert.match(lastGoal(session).evidence, /tests pass/);
  assert.equal(goalMessages(session).length, 1, "one continuation message in context");
  assert.equal(uiCalls.filter(([name, key, placement]) => name === "setWidget" && key === GOAL && placement === "aboveEditor").length, 1);
  assert.match(widgetFactory({ requestRender() {} }, theme).render(80)[0], /⚑ done · Verify fixture\.txt/);
  assert.match(readFileSync(session.sessionManager.getSessionFile(), "utf8"), /"customType":"loop-with-goal"/, "snapshot is on disk");
  assert.deepEqual(pendingDelays(), []);
  assert.match(await status(opened), /Goal: done/);

  // 3. Blocked stays unfinished; resume dispatches immediately; three idle stops block instead of looping.
  await session.prompt("/goal clear");
  assert.equal(lastGoal(session), undefined);
  assert.equal(widgetFactory, undefined, "cleared goal removes the widget");
  script = [{ toolCall: { name: "goal_control", arguments: { action: "blocked", evidence: "Permission to write /etc was denied by guardrails" } } }, { text: "Blocked." }];
  settled = nextSettled(session);
  await session.prompt("/goal Write the config file");
  await settled;
  assert.equal(lastGoal(session).status, "blocked");
  assert.match(lastGoal(session).blockedReason, /denied/);
  assert.deepEqual(pendingDelays(), []);
  const beforeResume = streams.length;
  script = [{ text: "nothing" }, { text: "still nothing" }, { text: "no tools again" }];
  settled = nextSettled(session);
  await session.prompt("/goal resume");
  await settled;
  assert.equal(streams.length, beforeResume + 3);
  assert.match(contextOf(beforeResume), /The user resumed the goal/);
  assert.equal(lastGoal(session).status, "blocked");
  assert.match(lastGoal(session).blockedReason, /3 consecutive stops without tool activity/);
  await session.prompt("/goal clear");

  // 4. Native retries finish first; the supervisor never schedules while Pi still retries.
  script = [{ error: "503 overloaded" }, { error: "503 overloaded" }, read, done(), { text: "ok" }];
  settled = nextSettled(session);
  await session.prompt("/goal Retry then finish");
  await settled;
  assert.deepEqual(streams.slice(-5).map(({ step }) => step.error ?? step.toolCall?.name ?? step.text), ["503 overloaded", "503 overloaded", "read", "goal_control", "ok"]);
  assert.equal(lastGoal(session).status, "done");
  assert.equal(lastGoal(session).failures, 0);
  assert.deepEqual(pendingDelays(), []);
  await session.prompt("/goal clear");

  // 5. Exhausted retries back off (5s, then 10s) with one request per attempt; success resets the counter.
  script = [{ error: "503 overloaded" }, { error: "503 overloaded" }, { error: "502 bad gateway" }];
  settled = nextSettled(session);
  await session.prompt("/goal Survive an outage");
  await settled;
  assert.deepEqual(pendingDelays(), [5000]);
  assert.equal(lastGoal(session).failures, 1);
  assert.match(await status(opened), /retry 1\/10 in 5s/);
  script = [{ error: "503 overloaded" }, { error: "503 overloaded" }, { error: "503 overloaded" }];
  settled = nextSettled(session);
  fire(5000);
  await settled;
  assert.deepEqual(pendingDelays(), [10000]);
  assert.equal(lastGoal(session).failures, 2);
  const beforeRecovery = streams.length;
  script = [read, done(), { text: "recovered" }];
  settled = nextSettled(session);
  fire(10000);
  await settled;
  assert.match(contextOf(beforeRecovery), /The previous request failed \(503 overloaded\); recovering/);
  assert.equal(streams.length, beforeRecovery + 3);
  assert.equal(lastGoal(session).status, "done");
  assert.equal(lastGoal(session).failures, 0);
  assert.deepEqual(pendingDelays(), []);
  await session.prompt("/goal clear");

  // 6. Permanent errors block visibly instead of looping.
  script = [{ error: "401 Unauthorized: invalid api key" }];
  settled = nextSettled(session);
  await session.prompt("/goal Needs auth");
  await settled;
  assert.equal(lastGoal(session).status, "blocked");
  assert.match(lastGoal(session).blockedReason, /401/);
  assert.deepEqual(pendingDelays(), []);
  await session.prompt("/goal clear");

  // 7. Main abort pauses durably; model progress/done cannot unpause; resume continues.
  const held = { hold: true };
  script = [held];
  settled = nextSettled(session);
  await session.prompt("/goal Long task");
  await until(() => held.started, "held stream");
  await session.abort();
  await settled;
  let goal = lastGoal(session);
  assert.equal(goal.paused, true);
  assert.equal(goal.pausedBy, "interrupt");
  assert.deepEqual(pendingDelays(), []);
  assert.match(widgetFactory({ requestRender() {} }, theme).render(80)[0], /paused · Long task · interrupt — \/goal resume/);
  script = [{ toolCall: { name: "goal_control", arguments: { action: "progress", evidence: "Manual check: fixture.txt still present on disk" } } }, done(), { text: "Claimed done while paused." }];
  await session.prompt("status?");
  await session.waitForIdle();
  goal = lastGoal(session);
  assert.equal(goal.paused, true, "model calls never unpause");
  assert.equal(goal.status, "done");
  assert.deepEqual(goalMessages(session).filter((message) => /stopped, but the goal/.test(JSON.stringify(message.content))).length, 3, "no continuation while paused");
  assert.deepEqual(pendingDelays(), []);
  await session.prompt("/goal clear");

  // 8. Escape during a native retry sleep pauses before the retry resolves; no supervisor recovery follows.
  script = [{ error: "503 overloaded" }, { text: "after cancelled retry" }];
  const retry = nextRetry(session);
  settled = nextSettled(session);
  await session.prompt("/goal Retry interrupted");
  await retry;
  escape();
  session.abortRetry();
  await settled;
  goal = lastGoal(session);
  assert.equal(goal.paused, true);
  assert.equal(goal.pausedBy, "interrupt");
  assert.equal(script.length, 1, "no further request");
  assert.deepEqual(pendingDelays(), []);
  await session.prompt("/goal clear");

  // 9. Escape during supervisor backoff clears the timer synchronously.
  script = [{ error: "503 overloaded" }, { error: "503 overloaded" }, { error: "503 overloaded" }];
  settled = nextSettled(session);
  await session.prompt("/goal Backoff interrupted");
  await settled;
  assert.deepEqual(pendingDelays(), [5000]);
  escape();
  assert.deepEqual(pendingDelays(), [], "latch cancels the timer before any await");
  assert.equal(lastGoal(session).paused, true);
  escape();
  assert.equal(lastGoal(session).paused, true, "idle Escape with nothing pending is ignored");
  await session.prompt("/goal clear");
  escape();
  assert.equal(lastGoal(session), undefined, "Escape without a goal is a no-op");

  // 10. A directly cancelled questionnaire pauses the goal; a UI failure does not.
  const ask = { toolCall: { name: "ask_user_question", arguments: { questions: [{ question: "Which parser?", header: "Parser", options: [{ label: "New", description: "The rewritten parser" }, { label: "Old", description: "The legacy parser" }] }] } } };
  answer = () => ({ answers: [], cancelled: true });
  script = [ask, { text: "User cancelled." }];
  settled = nextSettled(session);
  await session.prompt("/goal Ask the user");
  await settled;
  goal = lastGoal(session);
  assert.equal(goal.paused, true);
  assert.equal(goal.pausedBy, "questionnaire");
  await session.prompt("/goal clear");
  const invalidAsk = { toolCall: { name: "ask_user_question", arguments: { questions: [{ question: "Which parser?", header: "Parser", options: [{ label: "Only", description: "one option is invalid" }] }] } } };
  script = [invalidAsk, done(), { text: "Questionnaire errored" }];
  settled = nextSettled(session);
  await session.prompt("/goal Ask again");
  await settled;
  assert.equal(lastGoal(session).paused, false, "a questionnaire error envelope (cancelled + error) is not a user cancellation");
  assert.equal(lastGoal(session).status, "done");
  await session.prompt("/goal clear");

  // A recovery timer expiring behind a dialog is deferred, not lost or dispatched into the dialog.
  script = [{ error: "503 overloaded" }, { error: "503 overloaded" }, { error: "503 overloaded" }];
  settled = nextSettled(session);
  await session.prompt("/goal Recover after the dialog closes");
  await settled;
  const dialogEvent = async (type) => {
    for (const handler of opened.extension.handlers.get(type) ?? []) await handler({ type, kind: "custom", title: "Test dialog" }, {});
  };
  await dialogEvent("ui_prompt_start");
  const beforeDialog = streams.length;
  fire(5000);
  assert.equal(streams.length, beforeDialog, "no recovery while the dialog owns input");
  assert.deepEqual(pendingDelays(), []);
  await dialogEvent("ui_prompt_end");
  assert.deepEqual(pendingDelays(), [1000], "dialog completion re-arms the deferred recovery");
  script = [done("Dialog closed; every criterion verified successfully"), { text: "ok" }];
  settled = nextSettled(session);
  fire(1000);
  await settled;
  assert.equal(lastGoal(session).status, "done");
  await session.prompt("/goal clear");

  // 11. Children: a live async worker gates continuation; its failure wakes the idle parent once, is never rerun, and the runner's own wake-up is claimed.
  const { subagentTool } = opened;
  const toolCtx = { cwd: root, sessionManager: session.sessionManager, modelRegistry: registry, model: cheap, isProjectTrusted: () => false, scopedModels: [], hasUI: true, mode: "tui", ui: uiContext };
  const runChild = (task, extra = {}) => subagentTool.execute(`run-${Math.random()}`, { action: "run", agent: "oracle", task, ...extra }, new AbortController().signal, undefined, toolCtx);
  const waitChild = (runId) => subagentTool.execute("wait", { action: "wait", runId }, new AbortController().signal, undefined, toolCtx);
  const childHold = { hold: true };
  script = [childHold];
  const failing = await runChild("Investigate", { async: true });
  await until(() => childHold.started, "child stream");
  script = [{ text: "Delegating." }];
  settled = nextSettled(session);
  await session.prompt("/goal Delegate");
  await settled;
  assert.deepEqual(pendingDelays(), [], "live child gates continuation");
  assert.equal(script.length, 0, "no inline continuation while a child is live");
  assert.match(await status(opened), /Live subagents: 1/);
  const parentMessages = session.messages.length;
  childHold.fail("child exploded: invalid request");
  const failed = await waitChild(failing.details.run.id);
  assert.equal(failed.details.run.status, "failed");
  await settle(30);
  assert.deepEqual(pendingDelays(), [1000], "idle parent is woken after the child settles");
  assert.ok(!session.messages.slice(parentMessages).some((message) => message.customType === "subagent-run-ended"), "runner wake-up suppressed by the claim");
  const beforeWake = streams.length;
  script = [done("Worker report inspected; failure is understood, no retry"), { text: "ok" }];
  settled = nextSettled(session);
  fire(1000);
  await settled;
  assert.match(contextOf(beforeWake), /A subagent finished while you were idle[\s\S]*do not rerun or continue them unless the user asks[\s\S]*oracle \(.*\) failed: All models failed/);
  assert.equal(streams.length, beforeWake + 2, "worker was not rerun");
  assert.equal(lastGoal(session).pendingChildOutcomes.length, 0);
  assert.equal(lastGoal(session).status, "done");
  await session.prompt("/goal clear");

  // A failed child cannot restart a goal that became blocked and was then explicitly paused.
  const blockedChild = { hold: true };
  script = [blockedChild];
  const blockedRun = await runChild("Investigate without restarting the parent", { async: true });
  await until(() => blockedChild.started, "blocked-goal child stream");
  script = [{ toolCall: { name: "goal_control", arguments: { action: "blocked", evidence: "Missing deployment permission; waiting for user authorization" } } }, { text: "Blocked." }];
  settled = nextSettled(session);
  await session.prompt("/goal Deployment requires permission");
  await settled;
  await session.prompt("/goal pause");
  const blockedMessageCount = session.messages.length;
  const blockedStreamCount = streams.length;
  blockedChild.fail("invalid request");
  await waitChild(blockedRun.details.run.id);
  await settle(30);
  assert.equal(lastGoal(session).paused, true);
  assert.equal(lastGoal(session).status, "blocked");
  assert.equal(lastGoal(session).pendingChildOutcomes.length, 1);
  assert.equal(streams.length, blockedStreamCount, "paused blocked goal stays idle when a child fails");
  assert.ok(!session.messages.slice(blockedMessageCount).some((message) => message.customType === "subagent-run-ended"));
  assert.deepEqual(pendingDelays(), []);
  await session.prompt("/goal clear");

  // 12. A cancelled child questionnaire pauses the goal, keeps the outcome for /goal resume, and never continues the child.
  let resolveAnswer;
  answer = () => new Promise((resolve) => { resolveAnswer = resolve; });
  const contact = { toolCall: { name: "contact_parent", arguments: { questions: [{ question: "Which parser?", header: "Parser", options: [{ label: "New", description: "The rewritten parser" }, { label: "Old", description: "The legacy parser" }] }] } } };
  script = [contact, { text: "MUST_NOT_RUN" }];
  const asking = await runChild("Ask", { async: true });
  await until(() => resolveAnswer, "child questionnaire open");
  script = [{ text: "Waiting for the worker." }];
  settled = nextSettled(session);
  await session.prompt("/goal Child asks the user");
  await settled;
  assert.deepEqual(pendingDelays(), [], "waiting child gates continuation");
  const beforeCancel = session.messages.length;
  resolveAnswer({ answers: [], cancelled: true });
  const cancelled = await waitChild(asking.details.run.id);
  assert.equal(cancelled.details.run.status, "aborted");
  await settle(50);
  goal = lastGoal(session);
  assert.equal(goal.paused, true);
  assert.equal(goal.pausedBy, "questionnaire");
  assert.equal(goal.pendingChildOutcomes.length, 1);
  assert.match(goal.pendingChildOutcomes[0], /oracle .* aborted/);
  assert.deepEqual(pendingDelays(), []);
  assert.ok(!session.messages.slice(beforeCancel).some((message) => message.customType === "subagent-run-ended"), "paused goal is not restarted by the runner");
  assert.ok(streams.every(({ step }) => step.text !== "MUST_NOT_RUN") && script.length === 0, "cancelled child never continued");
  const beforeChildResume = streams.length;
  script = [done("Cancelled worker left alone; remaining criteria verified manually"), { text: "ok" }];
  settled = nextSettled(session);
  await session.prompt("/goal resume");
  await settled;
  assert.match(contextOf(beforeChildResume), /The user resumed the goal[\s\S]*aborted[\s\S]*Which parser/);
  assert.equal(lastGoal(session).pendingChildOutcomes.length, 0);
  assert.equal(script.length, 0);
  await session.prompt("/goal clear");
  answer = () => ({ answers: [], cancelled: true });

  // 13. Viewer cancellation is reported before the abort and pauses the goal.
  const viewerHold = { hold: true };
  script = [viewerHold];
  const viewed = await runChild("Hold on", { async: true });
  await until(() => viewerHold.started, "child stream");
  script = [{ text: "Delegating again." }];
  settled = nextSettled(session);
  await session.prompt("/goal Viewer cancel");
  await settled;
  let viewer;
  uiContext.custom = async (factory) => new Promise((resolve) => {
    viewer = factory({ requestRender() {}, terminal: { columns: 100, rows: 30 } }, { fg: (_c, t) => String(t), bg: (_c, t) => String(t), bold: (t) => String(t) }, { matches: () => false }, resolve);
  });
  const viewing = opened.subagents.commands.get("subagents-status").handler("", { ...toolCtx, ui: uiContext });
  await until(() => viewer, "status viewer");
  viewer.render(100);
  viewer.handleInput("c");
  await until(() => lastGoal(session)?.paused, "viewer pause");
  assert.equal(lastGoal(session).pausedBy, "child-viewer");
  const viewedResult = await waitChild(viewed.details.run.id);
  assert.equal(viewedResult.details.run.status, "aborted");
  viewer.handleInput("q");
  await viewing;
  uiContext.custom = async () => answer();
  await settle(50);
  assert.deepEqual(pendingDelays(), []);
  assert.equal(lastGoal(session).pendingChildOutcomes.length, 1);

  // 14. The latch survives compaction and reopen; progress is branch-local; reopening an active goal arms a guarded continuation.
  script = [{ text: "Summary of earlier work." }];
  await session.compact();
  assert.equal(lastGoal(session).paused, true, "compaction keeps the latch");
  const compaction = session.sessionManager.getBranch().find((entry) => entry.type === "compaction");
  assert.ok(compaction, "compaction entry exists");
  assert.ok(goalMessages(session).some((message) => /Context was compacted/.test(JSON.stringify(message.content))), "reminder follows compaction");
  const sessionFile = session.sessionManager.getSessionFile();
  const shutdown = (reason) => Promise.all(opened.extension.handlers.get("session_shutdown").map((handler) => handler({ type: "session_shutdown", reason }, {})));
  await shutdown("resume");
  session.dispose();
  widgetFactory = undefined;
  opened = await open(SessionManager.open(sessionFile));
  ({ session } = opened);
  goal = lastGoal(session);
  assert.equal(goal.paused, true, "reopen keeps the latch");
  assert.deepEqual(pendingDelays(), [], "paused goal does not continue on reopen");
  assert.match(widgetFactory({ requestRender() {} }, theme).render(80)[0], /paused/);
  script = [{ toolCall: { name: "goal_control", arguments: { action: "progress", evidence: "Branch-local evidence recorded on branch A" } } }, done("Branch A finished all criteria"), { text: "ok" }];
  settled = nextSettled(session);
  await session.prompt("/goal resume");
  await settled;
  assert.match(lastGoal(session).evidence, /Branch A finished/);
  await session.navigateTree(compaction.id);
  goal = lastGoal(session);
  assert.equal(goal.paused, false, "latest user control (resume) applies on the sibling");
  assert.doesNotMatch(goal.evidence ?? "", /Branch A/, "sibling branches do not share progress");
  assert.equal(goal.status, "active");
  assert.deepEqual(pendingDelays(), [], "tree navigation does not auto-dispatch");
  assert.match(notices.at(-1), /Goal on this branch is active; \/goal resume continues it/);
  // Reopening resumes at the last written entry, so pin the branch position as any later entry would.
  session.sessionManager.appendCustomEntry("test-marker", {});
  await shutdown("resume");
  session.dispose();
  widgetFactory = undefined;
  opened = await open(SessionManager.open(sessionFile));
  ({ session } = opened);
  assert.deepEqual(pendingDelays(), [3000], "active goal is rearmed on reopen");
  await shutdown("quit");
  assert.deepEqual(pendingDelays(), [], "shutdown cancels pending timers");
  session.dispose();
  widgetFactory = undefined;
  opened = await open(SessionManager.open(sessionFile));
  ({ session } = opened);
  const beforeReopen = streams.length;
  script = [done("Reopened session verified every criterion"), { text: "ok" }];
  settled = nextSettled(session);
  fire(3000);
  await settled;
  assert.match(contextOf(beforeReopen), /This session was reopened; the goal is still active/);
  assert.equal(lastGoal(session).status, "done");
  assert.deepEqual(pendingDelays(), []);

  // 15. Malformed persisted state fails safe on reopen.
  session.sessionManager.appendCustomEntry(GOAL, { version: 1, goalId: "x", text: 42 });
  await shutdown("resume");
  session.dispose();
  widgetFactory = undefined;
  opened = await open(SessionManager.open(sessionFile));
  ({ session } = opened);
  assert.equal(lastGoal(session), undefined);
  assert.equal(widgetFactory, undefined);
  assert.deepEqual(pendingDelays(), []);
  const beforePlain = goalMessages(session).length;
  script = [{ text: "plain" }];
  await session.prompt("hello");
  await session.waitForIdle();
  assert.equal(script.length, 0);
  assert.equal(goalMessages(session).length, beforePlain, "no goal, no continuation");
  console.log("loop-with-goal lifecycle test passed (no API calls)");
} finally {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSet;
  globalThis.clearTimeout = realClear;
  session?.dispose();
}
