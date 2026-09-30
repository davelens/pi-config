import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(repo, ".subagents-decision-model-test-"));
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
} });
const { chooseModel, decisionCandidates, readDecisionModel, writeDecisionModel } = await jiti.import(join(repo, "extensions/subagents/decision-model.ts"));
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Network access is not allowed in this test"); };
const model = (provider, id, extra = {}) => ({ id, name: id, api: "openai-completions", provider, baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192, ...extra });

// Settings persistence.
{
  const settingsPath = join(root, "settings.json");
  assert.equal(readDecisionModel(settingsPath), false, "missing settings default off");
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", subagents: { aliases: { coder: "worker" } } }, null, 2));
  assert.equal(readDecisionModel(settingsPath), false);
  writeDecisionModel(settingsPath, true);
  assert.equal(readDecisionModel(settingsPath), true);
  const written = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(written, { theme: "dark", subagents: { aliases: { coder: "worker" }, decisionModel: true } });
  writeDecisionModel(settingsPath, false);
  assert.equal(readDecisionModel(settingsPath), false);
  writeFileSync(settingsPath, JSON.stringify({ subagents: { decisionModel: "yes" } }));
  assert.equal(readDecisionModel(settingsPath), false, "non-boolean is off");
  writeFileSync(settingsPath, "{ not json");
  assert.throws(() => readDecisionModel(settingsPath), /not valid JSON/);
  assert.throws(() => writeDecisionModel(settingsPath, true), /not valid JSON/);
  assert.equal(readFileSync(settingsPath, "utf8"), "{ not json", "corrupt settings are never overwritten");
  writeFileSync(settingsPath, "[]");
  assert.throws(() => writeDecisionModel(settingsPath, true), /JSON object/);
}

// Candidate filtering, exclusions, pins, and thinking maps.
{
  const cheap = model("openai", "cheap");
  const smart = model("openai", "smart", { reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "x" } });
  const local = model("llamacpp", "qwen", { reasoning: true });
  const native = model("llama.cpp", "qwen", { reasoning: true });
  const stale = model("anthropic", "gone");
  const available = [cheap, smart, local, native];
  const pair = ({ model, thinking }) => `${model.provider}/${model.id}:${thinking}`;
  assert.deepEqual(decisionCandidates([], available).map(pair), [
    "openai/cheap:off",
    "openai/smart:off", "openai/smart:low", "openai/smart:medium", "openai/smart:high", "openai/smart:xhigh",
  ]);
  assert.deepEqual(decisionCandidates([{ model: smart, thinkingLevel: "high" }, { model: smart }, { model: stale }, { model: local }, { model: cheap, thinkingLevel: "high" }], available).map(pair), [
    "openai/smart:high",
    "openai/cheap:off",
  ], "pins are honored when supported, duplicates and unavailable or excluded models are dropped");
  assert.deepEqual(decisionCandidates([{ model: cheap }], []), []);
}

// Native classifier context, answer validation, and abort behavior.
{
  const cheap = model("openai", "cheap");
  const smart = model("openai", "smart", { reasoning: true });
  const candidates = decisionCandidates([], [cheap, smart]);
  const classifier = { id: "jev-latest", provider: "typesafe" };
  const agent = { name: "worker", description: "Builds things", tools: ["read", "edit"], model: "openai/cheap", thinking: "low" };
  const base = { task: "Refactor the parser", agent, candidates, classifier, signal: new AbortController().signal, timeoutMs: 1000 };
  let received;
  const classify = async (_model, context, options) => { received = { context, options }; return { stopReason: "stop", answers: { route: { type: "choice", choice: "option5", confidence: 0.2 } } }; };
  assert.deepEqual(await chooseModel({ ...base, classify }), { model: "openai/smart", thinking: "high" });
  assert.deepEqual(received.context.state, { task: "Refactor the parser", agent: { name: "worker", description: "Builds things", tools: ["read", "edit"] } });
  assert.equal(received.context.questions.route.criteria.option5.includes('"thinking":"high"'), true);
  assert.equal(JSON.parse(received.context.questions.route.criteria.defaults).useAgentDefaults, true);
  assert.ok(received.options.signal instanceof AbortSignal);
  assert.ok(Object.values(received.context.questions.route.criteria).every((value) => typeof value === "string"));
  assert.doesNotMatch(JSON.stringify(received.context), /baseUrl|127\.0\.0\.1/);
  assert.equal(await chooseModel({ ...base, classify: async () => ({ stopReason: "stop", answers: { route: { type: "choice", choice: "defaults" } } }) }), undefined);
  await assert.rejects(chooseModel({ ...base, classify: async () => ({ stopReason: "error", errorMessage: "sensitive response body" }) }), (error) => /check \/login typesafe/.test(error.message) && !error.message.includes("sensitive response body"));
  await assert.rejects(chooseModel({ ...base, classify: async () => ({ stopReason: "aborted", answers: {} }) }), /classification was aborted/);
  await assert.rejects(chooseModel({ ...base, classify: async () => ({ stopReason: "stop", answers: {} }) }), /invalid routing answer/);
  await assert.rejects(chooseModel({ ...base, classify: async () => ({ stopReason: "stop", answers: { route: { type: "choice", choice: "outside-pool" } } }) }), /invalid routing answer/);
  await assert.rejects(chooseModel({ ...base, classifier: undefined, classify }), /classifier is unavailable/);
  await assert.rejects(chooseModel({ ...base, candidates: [] }), /No routable models/);
  await assert.rejects(chooseModel({ ...base, candidates: Array.from({ length: 255 }, () => candidates[0]), classify }), /exceed the 254 choice limit/);
  const aborter = new AbortController();
  aborter.abort();
  await assert.rejects(chooseModel({ ...base, signal: aborter.signal, classify }), { name: "AbortError" });
  const keepAlive = setTimeout(() => {}, 20);
  await assert.rejects(chooseModel({ ...base, timeoutMs: 5, classify: (_model, _context, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ stopReason: "aborted", answers: {} }))) }), { name: "TimeoutError" });
  clearTimeout(keepAlive);
}

// The actual runner: override, fallback safety, async cancellation, and parent questionnaires.
let session;
try {
  const { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), "{}");
  symlinkSync(join(repo, "npm"), join(agentDir, "npm"), "dir");
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [join(repo, "extensions/subagents/index.ts")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const streams = [];
  let script = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const modelDefinition = (id, extra = {}) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192, ...extra });
  runtime.registerProvider("fake", {
    apiKey: "fake-key",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9",
    models: [modelDefinition("cheap"), modelDefinition("smart", { reasoning: true }), modelDefinition("spare")],
    streamSimple(model, context, options) {
      const step = script.shift() ?? { text: "DONE" };
      const last = context.messages.at(-1);
      streams.push({ model: `${model.provider}/${model.id}`, reasoning: options?.reasoning, ...(last?.role === "toolResult" ? { toolResult: last.content.map((part) => part.text ?? "").join("") } : {}) });
      const stream = createAssistantMessageEventStream();
      const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
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
  const smart = registry.find("fake", "smart");
  assert.ok(cheap && smart);
  ({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, modelRuntime: runtime, model: cheap, sessionManager: SessionManager.inMemory(root), tools: ["read"] }));
  const managed = join(root, ".config/agents/pi");
  writeFileSync(join(managed, "oracle.md"), "---\nname: oracle\ndescription: Test oracle\nmodel: fake/cheap\nfallbackModels: fake/spare\nthinking: low\ntools: read\n---\nAnswer briefly.\n");
  const extension = loader.getExtensions().extensions.find((candidate) => candidate.tools.has("subagent"));
  const tool = extension.tools.get("subagent").definition;
  const command = extension.commands.get("subagent-decision-model");
  const notices = [];
  const ctx = {
    cwd: root, modelRegistry: registry, model: session.model, isProjectTrusted: () => false,
    scopedModels: [{ model: cheap }, { model: smart, thinkingLevel: "high" }],
    ui: { notify: (message, level) => notices.push(`${level}: ${message}`) },
  };
  const run = (task, extra = {}) => tool.execute(`run-${Math.random()}`, { action: "run", agent: "oracle", task, ...extra }, new AbortController().signal, undefined, ctx);
  const originalDefinition = readFileSync(join(managed, "oracle.md"), "utf8");
  let classifyCalls = 0;
  registry.getModelOfType = (...args) => {
    assert.deepEqual(args, ["classifier", "typesafe", "jev-latest"]);
    return { id: "jev-latest", provider: "typesafe" };
  };
  const jevAnswer = (choice) => async (_classifier, context, options) => {
    classifyCalls++;
    options.signal.throwIfAborted();
    const ids = Object.keys(context.questions.route.criteria);
    return { stopReason: "stop", answers: { route: { type: "choice", choice: choice(ids, context), confidence: 0.5, probabilities: {} } } };
  };
  registry.classify = (...args) => currentClassifier(...args);
  let currentClassifier = async () => ({ stopReason: "error", errorMessage: "credentials not configured" });

  await command.handler("", ctx);
  assert.match(notices.at(-1), /^info: Subagent decision model is off/);
  await command.handler("maybe", ctx);
  assert.match(notices.at(-1), /^error: Usage/);
  await command.handler("key", ctx);
  assert.match(notices.at(-1), /\/login typesafe/);
  await command.handler("on", ctx);
  assert.equal(readDecisionModel(join(agentDir, "settings.json")), true);

  // Disabled: no key, no network, configured defaults.
  await command.handler("off", ctx);
  script = [{ text: "CHEAP_OK" }];
  let result = await run("Say hi");
  assert.match(result.content[0].text, /CHEAP_OK/);
  assert.match(result.content[0].text, /Model: fake\/cheap \(thinking: off\)/);
  assert.equal(result.details.thinking, "off");
  assert.deepEqual(streams.splice(0), [{ model: "fake/cheap", reasoning: undefined }]);
  assert.equal(classifyCalls, 0);

  // Enabled without a key: warns, keeps defaults, and stores the warning in the report.
  writeDecisionModel(join(agentDir, "settings.json"), true);
  script = [{ text: "DEFAULT_OK" }];
  result = await run("Say hi again");
  assert.match(result.content[0].text, /DEFAULT_OK/);
  assert.match(result.content[0].text, /Warning: Model routing failed, using configured defaults: .*check \/login typesafe/);
  assert.match(readFileSync(result.details.report, "utf8"), /- Warning: Model routing failed.*check \/login typesafe/);
  assert.match(notices.at(-1), /^warning: oracle: Model routing failed/);
  assert.deepEqual(streams.splice(0), [{ model: "fake/cheap", reasoning: undefined }]);
  assert.equal(classifyCalls, 0);

  // Routed override: Jev picks the pinned smart/high pair, definitions stay untouched.
  currentClassifier = jevAnswer((ids, context) => {
    const criteria = context.questions.route.criteria;
    assert.deepEqual(ids.map((id) => JSON.parse(criteria[id]).useAgentDefaults ? "defaults" : JSON.parse(criteria[id]).model), ["fake/cheap", "fake/smart", "defaults"], "scope intersects availability and honors the pin");
    assert.equal(JSON.parse(criteria[ids[1]]).thinking, "high");
    return ids[1];
  });
  script = [{ text: "SMART_OK" }];
  result = await run("Design the parser refactor");
  assert.match(result.content[0].text, /SMART_OK/);
  assert.match(result.content[0].text, /Model: fake\/smart \(thinking: high\)/);
  assert.doesNotMatch(result.content[0].text, /Warning/);
  assert.equal(classifyCalls, 1);
  assert.deepEqual(streams.splice(0), [{ model: "fake/smart", reasoning: "high" }]);
  const report = readFileSync(result.details.report, "utf8");
  assert.match(report, /- Model: fake\/smart\n- Thinking: high/);
  assert.equal(readFileSync(join(managed, "oracle.md"), "utf8"), originalDefinition);
  const listed = await tool.execute("list", { action: "list" }, new AbortController().signal, undefined, ctx);
  assert.match(listed.content[0].text, /model=fake\/cheap; fallbacks=fake\/spare/);

  // Fallback safety: a failing routed attempt falls back to the configured chain with its original thinking.
  currentClassifier = jevAnswer((ids) => ids[1]);
  script = [{ error: "smart is down" }, { text: "FALLBACK_OK" }];
  result = await run("Explain the parser");
  assert.match(result.content[0].text, /FALLBACK_OK/);
  assert.match(result.content[0].text, /Model: fake\/cheap \(thinking: off\)/);
  assert.deepEqual(streams.splice(0), [{ model: "fake/smart", reasoning: "high" }, { model: "fake/cheap", reasoning: undefined }]);
  assert.equal(result.details.sessions.length, 2);

  // A routed model that is also configured is not attempted twice.
  currentClassifier = jevAnswer((ids) => ids[0]);
  script = [{ error: "cheap is down" }, { text: "SPARE_OK" }];
  result = await run("Explain the lexer");
  assert.match(result.content[0].text, /SPARE_OK/);
  assert.deepEqual(streams.splice(0).map(({ model }) => model), ["fake/cheap", "fake/spare"]);

  // Inheriting the parent model must not repeat that model after a routed failure.
  writeFileSync(join(managed, "oracle.md"), originalDefinition.replace("model: fake/cheap\n", ""));
  script = [{ error: "parent model is down" }, { text: "INHERITED_SPARE_OK" }];
  result = await run("Explain the inherited lexer");
  assert.match(result.content[0].text, /INHERITED_SPARE_OK/);
  assert.deepEqual(streams.splice(0).map(({ model }) => model), ["fake/cheap", "fake/spare"]);
  writeFileSync(join(managed, "oracle.md"), originalDefinition);

  // Jev defaults choice keeps configured defaults without a warning.
  currentClassifier = jevAnswer(() => "defaults");
  script = [{ text: "DEFAULTS_CHOICE_OK" }];
  result = await run("Say hi");
  assert.match(result.content[0].text, /DEFAULTS_CHOICE_OK/);
  assert.doesNotMatch(result.content[0].text, /Warning/);
  assert.deepEqual(streams.splice(0), [{ model: "fake/cheap", reasoning: undefined }]);

  // Native classifier failure warns and keeps defaults.
  currentClassifier = async () => ({ stopReason: "error", errorMessage: "sensitive response body" });
  script = [{ text: "HTTP_FALLBACK_OK" }];
  result = await run("Say hi");
  assert.match(result.content[0].text, /HTTP_FALLBACK_OK/);
  assert.match(result.content[0].text, /Warning: Model routing failed.*check \/login typesafe/);
  assert.deepEqual(streams.splice(0), [{ model: "fake/cheap", reasoning: undefined }]);

  // Async: returns while routing is pending; stop aborts the routing request instead of falling back.
  let routingSignal;
  currentClassifier = (_classifier, _context, options) => new Promise((resolve) => {
    routingSignal = options.signal;
    options.signal.addEventListener("abort", () => resolve({ stopReason: "aborted", answers: {} }));
  });
  script = [{ text: "SHOULD_NOT_RUN" }];
  const started = await run("Slow routing", { async: true });
  assert.match(started.content[0].text, /Started oracle asynchronously/);
  const runId = started.details.run.id;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(routingSignal && !routingSignal.aborted, "routing request is in flight");
  const stopped = await tool.execute("stop", { action: "stop", runId }, new AbortController().signal, undefined, ctx);
  assert.match(stopped.content[0].text, /Stopped/);
  assert.equal(routingSignal.aborted, true);
  assert.equal(stopped.details.run.status, "aborted");
  assert.doesNotMatch(readFileSync(stopped.details.run.filePath, "utf8"), /Warning/);
  assert.deepEqual(streams.splice(0), []);

  // Parent questions open the installed questionnaire; the user's answer reaches the same child turn without routing again.
  classifyCalls = 0;
  currentClassifier = jevAnswer((ids) => ids[1]);
  const question = (text, header = "Parser") => ({ question: text, header, options: [{ label: "New", description: "The rewritten parser" }, { label: "Old", description: "The legacy parser" }] });
  const ask = (...questions) => ({ toolCall: { name: "contact_parent", arguments: { questions } } });
  const asked = [];
  const plan = (...steps) => {
    script = steps;
    asked.splice(0, asked.length, ...steps.filter((step) => step.toolCall).map((step) => step.toolCall.arguments.questions));
  };
  const status = async (runId) => (await tool.execute("status", { action: "status", ...(runId ? { runId } : {}) }, new AbortController().signal, undefined, ctx)).details.runs;
  const wait = (runId) => tool.execute("wait", { action: "wait", runId }, new AbortController().signal, undefined, ctx);
  const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
  let open = 0;
  let answer = (questions) => ({ answers: questions.map((q, questionIndex) => ({ questionIndex, question: q.question, kind: "option", answer: "New" })), cancelled: false });
  ctx.hasUI = true;
  ctx.ui.custom = async (_factory, options) => {
    assert.equal(options?.overlay, true, "the installed questionnaire overlay is used");
    assert.equal(open++, 0, "questionnaires never overlap");
    await settle(5);
    open--;
    return answer(asked.shift());
  };
  plan(ask(question("Which parser?")), { text: "ANSWERED_OK" });
  result = await run("Pick a parser");
  assert.match(result.content[0].text, /ANSWERED_OK/);
  assert.match(result.content[0].text, /Model: fake\/smart \(thinking: high\)/);
  assert.equal(classifyCalls, 1, "answering does not route again");
  let seen = streams.splice(0);
  assert.deepEqual(seen.map(({ model }) => model), ["fake/smart", "fake/smart"]);
  assert.match(seen[1].toolResult, /"Which parser\?"="New"/, "the user's answer is the child's tool result");
  assert.match(readFileSync(result.details.report, "utf8"), /Status: completed/);
  assert.doesNotMatch(readFileSync(result.details.report, "utf8"), /Pending questions/);

  // Repeated questions after an answer each open the questionnaire again.
  plan(ask(question("Which parser?")), ask(question("Which lexer?", "Lexer")), { text: "TWICE_OK" });
  result = await run("Pick both");
  assert.match(result.content[0].text, /TWICE_OK/);
  seen = streams.splice(0);
  assert.equal(seen.length, 3);
  assert.match(seen[2].toolResult, /"Which lexer\?"="New"/);

  // Cancelling stops the child without retry, releases the writer lock, and names the questions.
  writeFileSync(join(managed, "scribe.md"), "---\nname: scribe\ndescription: Test writer\nmodel: fake/cheap\nfallbackModels: fake/spare\ntools: read, edit\n---\nWrite briefly.\n");
  answer = () => ({ answers: [], cancelled: true });
  plan(ask(question("Which parser?")), { text: "MUST_NOT_RUN" });
  await assert.rejects(run("Cancel me", { agent: "scribe" }), (error) => /cancel/i.test(error.message) && /Which parser\?/.test(error.message) && !/MUST_NOT_RUN/.test(error.message));
  assert.equal(streams.splice(0).length, 1, "no retry, no fallback, no question loop");
  const cancelled = (await status()).find(({ agent }) => agent === "scribe");
  assert.equal(cancelled.status, "aborted");
  assert.match(cancelled.error, /cancel/i);
  plan({ text: "LOCK_FREE" });
  result = await run("Write again", { agent: "scribe" });
  assert.match(result.content[0].text, /LOCK_FREE/);
  streams.splice(0);

  // A UI failure is a failed run carrying the questionnaire's own error, not a cancellation.
  answer = () => undefined;
  plan(ask(question("Which parser?")), { text: "MUST_NOT_RUN" });
  await assert.rejects(run("Broken UI"), /cannot render the questionnaire/);
  assert.equal((await status()).at(-1).status, "failed");
  ctx.hasUI = false;
  plan(ask(question("Which parser?")), { text: "MUST_NOT_RUN" });
  await assert.rejects(run("No UI"), /UI not available/);
  assert.equal((await status()).at(-1).status, "failed");
  ctx.hasUI = true;
  assert.equal(streams.splice(0).length, 2, "failures never continue the child");

  // Stopping an async run dismisses its open questionnaire and settles without leaking the lock.
  const opened = [];
  ctx.ui.custom = (factory) => new Promise(() => { opened.push(factory); });
  plan(ask(question("Which parser?")), { text: "MUST_NOT_RUN" });
  let asking = await run("Async question", { agent: "scribe", async: true });
  await settle();
  assert.equal(opened.length, 1, "the questionnaire opened for the async child");
  assert.match((await status(asking.details.run.id))[0].questions.join(), /Which parser\?/);
  assert.equal((await status(asking.details.run.id))[0].status, "waiting");
  const halted = await tool.execute("stop", { action: "stop", runId: asking.details.run.id }, new AbortController().signal, undefined, ctx);
  assert.equal(halted.details.run.status, "aborted");
  assert.equal(streams.splice(0).length, 1);
  ctx.ui.custom = async () => answer(asked.shift());
  plan({ text: "LOCK_FREE_AGAIN" });
  result = await run("Write after stop", { agent: "scribe" });
  assert.match(result.content[0].text, /LOCK_FREE_AGAIN/);
  streams.splice(0);

  // Async cancellation informs and wakes the parent instead of re-prompting; wait sees the aborted run.
  answer = () => ({ answers: [], cancelled: true });
  const parentMessages = session.messages.length;
  plan(ask(question("Which parser?")), { text: "MUST_NOT_RUN" });
  asking = await run("Async cancel", { async: true });
  const waited = await wait(asking.details.run.id);
  assert.equal(waited.details.run.status, "aborted");
  assert.match(waited.content[0].text, /cancel[\s\S]*Which parser\?/i);
  await settle(50);
  assert.match(notices.at(-1), /^error: oracle aborted: .*cancel/i);
  assert.ok(session.messages.slice(parentMessages).some((message) => message.role === "custom" && /cancel[\s\S]*Which parser\?/i.test(JSON.stringify(message.content))), "the parent is woken with the cancelled questions");
  streams.splice(0);

  // Concurrent read-only children serialize their questionnaires and each get their own answer.
  answer = (questions) => ({ answers: [{ questionIndex: 0, question: questions[0].question, kind: "custom", answer: `Answer to ${questions[0].header}` }], cancelled: false });
  ctx.ui.custom = async () => {
    assert.equal(open++, 0, "questionnaires never overlap");
    await settle(10);
    open--;
    return answer(asked.shift());
  };
  plan(ask(question("Which parser?", "First")), ask(question("Which lexer?", "Second")), { text: "FIRST_DONE" }, { text: "SECOND_DONE" });
  const first = await run("First question", { async: true });
  const second = await run("Second question", { async: true });
  const results = await Promise.all([first, second].map(({ details }) => wait(details.run.id)));
  assert.match(results[0].content[0].text, /FIRST_DONE/);
  assert.match(results[1].content[0].text, /SECOND_DONE/);
  seen = streams.splice(0);
  assert.deepEqual(seen.filter(({ toolResult }) => toolResult).map(({ toolResult }) => /Answer to (\w+)/.exec(toolResult)[1]).sort(), ["First", "Second"]);

  // A queued child can be stopped without waiting for another child's answer.
  ctx.ui.custom = () => new Promise(() => {});
  plan(ask(question("Which parser?")), ask(question("Which lexer?")));
  const blocking = await run("Open question", { async: true });
  await settle();
  const queued = await run("Queued question", { agent: "scribe", async: true });
  await settle();
  const stop = (runId) => tool.execute("stop", { action: "stop", runId }, new AbortController().signal, undefined, ctx);
  const stopping = stop(queued.details.run.id);
  const stoppedPromptly = await Promise.race([stopping.then(() => true), settle(250).then(() => false)]);
  await stop(blocking.details.run.id);
  await stopping;
  assert.equal(stoppedPromptly, true, "queued stop must not depend on another user's answer");
  assert.equal(streams.splice(0).length, 2);

  // RPC dialogs receive the child's abort signal as well.
  ctx.mode = "rpc";
  ctx.ui.input = async () => undefined;
  let dialogSignal;
  ctx.ui.select = (_title, _options, options) => new Promise((resolve) => {
    dialogSignal = options?.signal;
    dialogSignal?.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  plan(ask(question("Which parser?")));
  asking = await run("RPC question", { async: true });
  await settle();
  assert.ok(dialogSignal, "RPC dialog needs an abort signal");
  await stop(asking.details.run.id);
  assert.equal(dialogSignal.aborted, true);
  assert.equal(streams.splice(0).length, 1);
  ctx.mode = "tui";
  delete ctx.ui.select;
  delete ctx.ui.input;

  // Shutdown dismisses the real questionnaire component and settles the run.
  const closed = [];
  const theme = new Proxy({}, { get: () => (_color, text = "") => String(text) });
  ctx.ui.custom = (factory) => new Promise((resolve) => {
    opened.push(factory({ requestRender() {}, terminal: { columns: 80, rows: 24 } }, theme, { matches: () => false }, (value) => { closed.push(value); resolve(value); }));
  });
  plan(ask(question("Which parser?")), { text: "MUST_NOT_RUN" });
  asking = await run("Shutdown question", { async: true });
  await settle();
  assert.equal(opened.length, 2);
  await Promise.all(extension.handlers.get("session_shutdown").map((handler) => handler({ type: "session_shutdown" }, ctx)));
  assert.equal((await status(asking.details.run.id))[0].status, "aborted");
  assert.deepEqual(closed, [{ answers: [], cancelled: true }], "the open overlay was closed");
  assert.equal(streams.splice(0).length, 1);
  console.log("subagents decision model test passed (no API calls)");
} finally {
  globalThis.fetch = realFetch;
  session?.dispose();
}
