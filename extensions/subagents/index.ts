import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  truncateHead,
  type AgentSessionEvent,
  type ToolDefinition,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { agentConfigurationIssues, diagnoseAgentDefinitions, discoverAgents, FORBIDDEN_CHILD_SKILL, resolveAgent, type AgentConfig } from "./agents.ts";
import { ensureDefaultAgents } from "./agent-files.ts";
import { createContactParentTool } from "./contact-parent.ts";
import { buildDoctorReport } from "./doctor-report.ts";
import { SubagentsDoctor } from "./doctor.ts";
import { SubagentManager } from "./manager.ts";
import { promptChild } from "./prompt-child.ts";
import { acquireMutationLock, finishRunReport, pauseRunReport, resumeRunReport, startRunReport } from "./reports.ts";
import { captureRunMessage, trackRun, type ActiveRun } from "./run-stream.ts";
import { SubagentStatus } from "./status.ts";
import { formatParentRequest, formatResumePrompt, type ParentRequest } from "./supervision.ts";

const DEFAULT_AGENTS = fileURLToPath(new URL("./default-agents", import.meta.url));
const AGENTS_DIRECTORY = join(homedir(), ".config", "agents", "pi");
const REPORTS_DIRECTORY = join(AGENTS_DIRECTORY, "reports");
const GUARDRAILS_EXTENSION = join(getAgentDir(), "npm", "node_modules", "@aliou", "pi-guardrails", "extensions", "guardrails", "index.ts");
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const SUBAGENT_BOUNDARIES = `# Boundaries
Return only the requested deliverable and blockers, as concisely as correctness allows. Do one pass, stop when the task is answered, and do not expand scope, propose follow-up work, or continue searching for additional issues unless the task explicitly requires it.
Treat pre-existing worktree and index changes as human-owned. Preserve them: never stash, reset, restore, clean, discard, or overwrite unrelated changes. Stop and report a blocker when overlap prevents safe work.
When a required decision cannot be resolved from the task or repository, call contact_parent alone with 1-4 specific questions. Wait for the parent response, then continue the same task.`;
const gitInspectSchema = Type.Object({
  command: StringEnum(["git diff", "git diff --cached", "git status --short", "git diff <base>...HEAD", "git log <base>..HEAD --oneline"] as const),
  base: Type.Optional(Type.String({ description: "Base revision for commands containing <base>" })),
});
type GitInspectInput = Static<typeof gitInspectSchema>;
const ketchSchema = Type.Object({
  command: StringEnum(["search", "scrape", "crawl", "code", "docs"] as const),
  args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed directly to ketch without a shell" })),
});
type KetchInput = Static<typeof ketchSchema>;
const KETCH_FLAGS: Record<KetchInput["command"], Set<string>> = {
  search: new Set(["-b", "--backend", "-h", "--help", "-l", "--limit", "--max-chars", "--minimal", "--scrape", "--searxng-url", "--trim", "--json"]),
  scrape: new Set(["--concurrency", "--force-browser", "-h", "--help", "--max-chars", "--no-cache", "--no-llms-txt", "--raw", "--select", "--trim", "--json"]),
  crawl: new Set(["--allow", "--concurrency", "--deny", "--depth", "-h", "--help", "--no-cache", "--sitemap", "--json"]),
  code: new Set(["-b", "--backend", "-h", "--help", "--lang", "-l", "--limit", "--minimal", "--regex", "--json"]),
  docs: new Set(["-b", "--backend", "-h", "--help", "--library", "-l", "--limit", "--minimal", "--resolve", "--tokens", "--json"]),
};

function validateKetchArgs(command: KetchInput["command"], args: string[]): void {
  if (command === "crawl" && args.includes("stop")) throw new Error("Stopping background crawls is not available to read-only subagents");
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    const flag = arg.split("=", 1)[0]!;
    if (!KETCH_FLAGS[command].has(flag)) throw new Error(`Unsupported ketch ${command} flag: ${flag}`);
  }
}

interface CompletedAgentResult {
  status: "completed";
  output: string;
  model: string;
}

interface WaitingAgentResult {
  status: "waiting";
  model: string;
  request: ParentRequest;
  continuation: AgentContinuation;
}

type AgentResult = CompletedAgentResult | WaitingAgentResult;

interface AgentContinuation {
  resume(answer: string, signal: AbortSignal): Promise<AgentResult>;
  dispose(): void;
}

function pruneFinishedRuns(runs: Map<string, ActiveRun>, keep = 100): void {
  for (const [id, run] of runs) {
    if (runs.size <= keep) return;
    if (run.report.status !== "running" && run.report.status !== "waiting") runs.delete(id);
  }
}

function projectSettings(cwd: string): string | undefined {
  for (let directory = cwd; ; directory = dirname(directory)) {
    const candidate = join(directory, CONFIG_DIR_NAME, "settings.json");
    if (existsSync(candidate)) return candidate;
    if (dirname(directory) === directory) return;
  }
}

function settingsFor(ctx: ExtensionContext): string[] {
  const settings = [join(getAgentDir(), "settings.json")];
  const project = ctx.isProjectTrusted() ? projectSettings(ctx.cwd) : undefined;
  if (project && project !== settings[0]) settings.push(project);
  return settings;
}

function agentsFor(ctx: ExtensionContext): AgentConfig[] {
  const settingsPaths = settingsFor(ctx);
  return discoverAgents({
    agentsDirectory: AGENTS_DIRECTORY,
    settingsPaths,
    projectSettingsPath: settingsPaths.length > 1 ? settingsPaths.at(-1) : undefined,
  });
}

function childSettings(cwd: string, ctx: ExtensionContext): SettingsManager {
  return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
}

function applyChildRuntimeSettings(settings: SettingsManager): void {
  settings.applyOverrides({
    httpIdleTimeoutMs: 0,
    retry: { enabled: true, maxRetries: 2 },
  });
}

async function runtimeInventory(cwd: string, ctx: ExtensionContext) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: childSettings(cwd, ctx),
    additionalExtensionPaths: [GUARDRAILS_EXTENSION],
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return { skills: loader.getSkills(), guardrailErrors: loader.getExtensions().errors };
}

function formatSkillDiagnostic(diagnostic: { message: string; path?: string; collision?: { winnerPath: string; loserPath: string } }): string {
  if (diagnostic.collision) return `${diagnostic.message} (winner: ${diagnostic.collision.winnerPath}; ignored: ${diagnostic.collision.loserPath})`;
  return `${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`;
}

function textFromLastAssistantMessage(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
      errorMessage?: string;
    };
    if (message.role !== "assistant") continue;
    if (message.errorMessage) throw new Error(message.errorMessage);
    const text = message.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  throw new Error("Subagent returned no text response");
}

function resolveModelAvailable(modelName: string, ctx: ExtensionContext): boolean {
  const separator = modelName.indexOf("/");
  return separator > 0 && Boolean(ctx.modelRegistry.find(modelName.slice(0, separator), modelName.slice(separator + 1)));
}

function resolveModel(modelName: string | undefined, agent: AgentConfig, ctx: ExtensionContext) {
  if (!modelName) {
    if (!ctx.model) throw new Error("No model is active");
    return ctx.model;
  }

  const separator = modelName.indexOf("/");
  if (separator < 1) throw new Error(`Invalid model '${modelName}' for ${agent.name}`);
  const model = ctx.modelRegistry.find(modelName.slice(0, separator), modelName.slice(separator + 1));
  if (!model) throw new Error(`Model '${modelName}' for ${agent.name} is unavailable`);
  return model;
}

async function runAttempt(agent: AgentConfig, task: string, cwd: string, modelName: string | undefined, signal: AbortSignal, timeoutMs: number, ctx: ExtensionContext, pi: ExtensionAPI, onEvent?: (event: AgentSessionEvent) => void): Promise<AgentResult> {
  const model = resolveModel(modelName, agent, ctx);
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, signal });
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error(`Provider '${model.provider}' is unavailable`);
  modelRuntime.registerNativeProvider(provider);

  if (!existsSync(GUARDRAILS_EXTENSION)) throw new Error(`Subagent guardrails are unavailable: ${GUARDRAILS_EXTENSION}`);

  const configurationIssues = agentConfigurationIssues(agent);
  if (configurationIssues.length) throw new Error(`${agent.name}: ${configurationIssues.join("; ")}`);
  const settingsManager = childSettings(cwd, ctx);
  const selectedSkills = new Set(agent.skills ?? []);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    additionalExtensionPaths: [GUARDRAILS_EXTENSION],
    noExtensions: true,
    noSkills: selectedSkills.size === 0,
    noPromptTemplates: true,
    noThemes: true,
    skillsOverride: selectedSkills.size ? (base) => ({
      skills: base.skills
        .filter((skill) => skill.name !== FORBIDDEN_CHILD_SKILL && selectedSkills.has(skill.name))
        .map((skill) => ({ ...skill, disableModelInvocation: false })),
      diagnostics: base.diagnostics,
    }) : undefined,
    systemPromptOverride: (base) => `${base ?? ""}\n\n# Subagent role\n${agent.prompt}\n\n${SUBAGENT_BOUNDARIES}`.trim(),
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  applyChildRuntimeSettings(settingsManager);
  const extensionErrors = resourceLoader.getExtensions().errors;
  if (extensionErrors.length) throw new Error(`Could not load subagent guardrails: ${extensionErrors.map(({ error }) => error).join("; ")}`);
  const loadedSkills = new Set(resourceLoader.getSkills().skills.map((skill) => skill.name));
  const missingSkills = [...selectedSkills].filter((skill) => !loadedSkills.has(skill));
  if (missingSkills.length) throw new Error(`Skills not found for ${agent.name}: ${missingSkills.join(", ")}`);

  let pendingRequest: ParentRequest | undefined;
  const customTools: ToolDefinition[] = [createContactParentTool((request) => {
    pendingRequest = request;
  })];
  if (agent.tools.includes("git_inspect")) customTools.push({
    name: "git_inspect",
    label: "Read-only Git",
    description: "Run an allowed read-only Git diff, log, or status command",
    parameters: gitInspectSchema,
    async execute(_id: string, params: GitInspectInput, toolSignal?: AbortSignal) {
      const safeGit = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false"];
      const needsBase = params.command.includes("<base>");
      if (needsBase && (!params.base || params.base.startsWith("-"))) throw new Error("This git command requires a base revision that does not start with '-'");
      const args = params.command === "git status --short"
        ? [...safeGit, "status", "--short"]
        : params.command === "git diff --cached"
          ? [...safeGit, "diff", "--cached", "--no-ext-diff", "--no-textconv"]
          : params.command === "git diff <base>...HEAD"
            ? [...safeGit, "diff", "--no-ext-diff", "--no-textconv", `${params.base}...HEAD`]
            : params.command === "git log <base>..HEAD --oneline"
              ? [...safeGit, "log", `${params.base}..HEAD`, "--oneline"]
              : [...safeGit, "diff", "--no-ext-diff", "--no-textconv"];
      const result = await pi.exec("git", args, { cwd, signal: toolSignal });
      if (result.code !== 0) throw new Error(result.stderr || `git exited with ${result.code}`);
      return { content: [{ type: "text" as const, text: result.stdout || "(no output)" }], details: {} };
    },
  });
  if (agent.tools.includes("ketch")) customTools.push({
    name: "ketch",
    label: "Ketch",
    description: "Search or scrape the web, code, and library docs through ketch without shell access",
    parameters: ketchSchema,
    async execute(_id: string, params: KetchInput, toolSignal?: AbortSignal) {
      validateKetchArgs(params.command, params.args ?? []);
      const result = await pi.exec("ketch", [params.command, ...(params.args ?? [])], { cwd, signal: toolSignal });
      if (result.code !== 0) throw new Error(result.stderr || `ketch exited with ${result.code}`);
      return { content: [{ type: "text" as const, text: truncateHead(result.stdout || "(no output)").content }], details: {} };
    },
  });
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    thinkingLevel: agent.thinking,
    tools: [...agent.tools, "contact_parent"],
    customTools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  const unsubscribe = onEvent ? session.subscribe(onEvent) : undefined;
  const modelId = `${model.provider}/${model.id}`;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    session.dispose();
  };
  const continuation: AgentContinuation = {
    async resume(answer, resumeSignal) {
      const request = pendingRequest;
      if (!request) throw new Error("Subagent has no pending parent request");
      pendingRequest = undefined;
      try {
        await promptChild(session, formatResumePrompt(request, answer), resumeSignal, agent.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const nextRequest = pendingRequest as ParentRequest | undefined;
        if (nextRequest) return { status: "waiting", model: modelId, request: nextRequest, continuation };
        const result: CompletedAgentResult = { status: "completed", output: textFromLastAssistantMessage(session.messages), model: modelId };
        dispose();
        return result;
      } catch (error) {
        dispose();
        throw error;
      }
    },
    dispose,
  };

  try {
    await promptChild(session, task, signal, timeoutMs);
    const request = pendingRequest as ParentRequest | undefined;
    if (request) return { status: "waiting", model: modelId, request, continuation };
    const result: CompletedAgentResult = { status: "completed", output: textFromLastAssistantMessage(session.messages), model: modelId };
    dispose();
    return result;
  } catch (error) {
    dispose();
    throw error;
  }
}

async function runAgent(agent: AgentConfig, task: string, cwd: string, signal: AbortSignal, ctx: ExtensionContext, pi: ExtensionAPI, onEvent?: (event: AgentSessionEvent) => void): Promise<AgentResult> {
  const candidates = [...new Set([agent.model, ...(agent.fallbackModels ?? [])])];
  const errors: string[] = [];
  const writes = agent.tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write");
  const timeoutMs = agent.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (const candidate of candidates.length ? candidates : [undefined]) {
    let toolExecuted = false;
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(`Subagent timed out after ${timeoutMs}ms`);
      return await runAttempt(agent, task, cwd, candidate, signal, remainingMs, ctx, pi, (event) => {
        if (event.type === "tool_execution_start") toolExecuted = true;
        onEvent?.(event);
      });
    } catch (error) {
      if (signal.aborted || (writes && toolExecuted)) throw error;
      errors.push(`${candidate ?? "parent model"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`All models failed for ${agent.name}:\n${errors.join("\n")}`);
}

export default function subagents(pi: ExtensionAPI) {
  ensureDefaultAgents(DEFAULT_AGENTS, AGENTS_DIRECTORY);
  const runs = new Map<string, ActiveRun>();
  const continuations = new Map<string, { continuation: AgentContinuation; request: ParentRequest }>();
  const releases = new Map<string, () => void>();
  let refreshStatus: (() => void) | undefined;
  let shuttingDown = false;

  const cleanupRun = (runId: string) => {
    continuations.get(runId)?.continuation.dispose();
    continuations.delete(runId);
    releases.get(runId)?.();
    releases.delete(runId);
  };

  const settleRun = (run: ActiveRun, result: AgentResult) => {
    if (result.status === "waiting") {
      continuations.set(run.report.id, { continuation: result.continuation, request: result.request });
      pauseRunReport(run.report, result.model, result.request.questions);
    } else {
      finishRunReport(run.report, { status: "completed", model: result.model, output: result.output });
      cleanupRun(run.report.id);
    }
    refreshStatus?.();
    return result;
  };

  const executeRun = async (run: ActiveRun, runSignal: AbortSignal, operation: () => Promise<AgentResult>) => {
    try {
      const result = await operation();
      runSignal.throwIfAborted();
      return settleRun(run, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishRunReport(run.report, { status: runSignal.aborted ? "aborted" : "failed", error: message });
      cleanupRun(run.report.id);
      refreshStatus?.();
      throw error;
    } finally {
      pruneFinishedRuns(runs);
    }
  };

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    for (const run of runs.values()) {
      if (run.report.status === "running" || run.report.status === "waiting") run.controller.abort();
      if (run.report.status === "waiting") {
        cleanupRun(run.report.id);
        finishRunReport(run.report, { status: "aborted", error: "Parent session ended while waiting for input" });
      }
    }
    await Promise.allSettled([...runs.values()].map(({ promise }) => promise));
    for (const run of runs.values()) cleanupRun(run.report.id);
  });

  pi.registerCommand("subagents-status", {
    description: "View live and completed subagent message streams",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const currentRuns = [...runs.values()];
      if (!currentRuns.some(({ report }) => report.status === "running" || report.status === "waiting")) {
        ctx.ui.notify("No subagents are running", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Subagent status requires the TUI", "error");
        return;
      }
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          refreshStatus = () => tui.requestRender();
          return new SubagentStatus({ tui, theme, runs: () => [...runs.values()], done });
        }, {
          overlay: true,
          overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
        });
      } finally {
        refreshStatus = undefined;
      }
    },
  });

  pi.registerCommand("subagents-doctor", {
    description: "Diagnose subagent definitions, models, skills, and runtime dependencies",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const agents = agentsFor(ctx);
      const inventory = await runtimeInventory(ctx.cwd, ctx);
      const availableSkills = new Set(inventory.skills.skills.map((skill) => skill.name).filter((skill) => skill !== FORBIDDEN_CHILD_SKILL));
      const report = buildDoctorReport({
        agents: agents.map((agent) => {
          const issues = [
            ...(agent.invalidTools?.length ? [`unsupported tools: ${agent.invalidTools.join(", ")}`] : []),
            ...agentConfigurationIssues(agent),
            ...(agent.warnings ?? []),
            ...(agent.model && !resolveModelAvailable(agent.model, ctx) ? [`model unavailable: ${agent.model}`] : []),
            ...(!agent.model && !ctx.model ? ["parent model unavailable"] : []),
            ...(agent.fallbackModels ?? []).filter((model) => !resolveModelAvailable(model, ctx)).map((model) => `fallback unavailable: ${model}`),
            ...(agent.skills ?? []).filter((skill) => !availableSkills.has(skill)).map((skill) => `skill missing: ${skill}`),
          ];
          return {
            name: agent.name,
            filePath: agent.filePath,
            model: agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id} (parent)` : "parent unavailable"),
            fallbackModels: agent.fallbackModels,
            tools: agent.tools,
            skills: agent.skills,
            issues,
          };
        }),
        definitionDiagnostics: diagnoseAgentDefinitions(AGENTS_DIRECTORY),
        skillDiagnostics: inventory.skills.diagnostics.map(formatSkillDiagnostic),
        availableSkills: [...availableSkills].sort(),
        guardrailsAvailable: existsSync(GUARDRAILS_EXTENSION) && inventory.guardrailErrors.length === 0,
        guardrailDiagnostics: inventory.guardrailErrors.map(({ path, error }) => `${error} (${path})`),
        agentsDirectory: AGENTS_DIRECTORY,
        reportsDirectory: REPORTS_DIRECTORY,
        activeRuns: [...runs.values()].filter(({ report }) => report.status === "running" || report.status === "waiting").length,
      });
      if (ctx.mode !== "tui") {
        ctx.ui.notify(report, "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SubagentsDoctor(tui, theme, report, done), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      });
    },
  });

  pi.registerCommand("subagents", {
    description: "Browse, create, edit, and rename configured subagents",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The subagent manager requires the TUI", "error");
        return;
      }
      await ctx.waitForIdle();
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SubagentManager({
        tui,
        theme,
        agents: () => agentsFor(ctx),
        agentsDirectory: AGENTS_DIRECTORY,
        defaultsDirectory: DEFAULT_AGENTS,
        settingsPaths: settingsFor(ctx),
        done,
      }), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      });
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "List or run Markdown-defined subagents, including asynchronous runs with saved reports.",
    promptSnippet: "List or run focused Markdown-defined subagents",
    promptGuidelines: [
      "Use subagent with action=list before choosing an unfamiliar agent.",
      "Use subagent with action=status to inspect asynchronous runs and action=stop to abort one.",
      "When a subagent pauses for parent input, answer from established context or use ask_user_question, then call subagent action=resume with the same runId and the answer.",
      "Use separate subagent calls for independent parallel tasks; mutation-capable subagents are limited to one per Git worktree.",
      "For user-approved broad implementation, use a planner first and dispatch its independent worker slices sequentially in dependency order.",
      "Run each worker slice once. Do not retry failed slices or add follow-up validation agents unless the current user explicitly asks.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "run", "resume", "status", "stop"] as const),
      agent: Type.Optional(Type.String({ description: "Agent name for action=run" })),
      task: Type.Optional(Type.String({ description: "Self-contained task for action=run" })),
      async: Type.Optional(Type.Boolean({ description: "Return immediately and run in the background" })),
      runId: Type.Optional(Type.String({ description: "Run ID for action=resume, status, or stop" })),
      answer: Type.Optional(Type.String({ description: "Parent or user answers for action=resume" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const agents = agentsFor(ctx);

      if (params.action === "list") {
        return {
          content: [{
            type: "text",
            text: agents.map((agent) =>
              `${agent.name}${agent.aliases?.length ? ` (aliases: ${agent.aliases.join(", ")})` : ""} — ${agent.description}; model=${agent.model ?? "parent"}${agent.fallbackModels?.length ? `; fallbacks=${agent.fallbackModels.join(",")}` : ""}; timeout=${agent.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms; tools=${agent.tools.join(",")}${agent.skills?.length ? `; skills=${agent.skills.join(",")}` : ""}${agent.invalidTools?.length ? `; INVALID TOOLS=${agent.invalidTools.join(",")}` : ""}${agent.warnings?.length ? `; warnings=${agent.warnings.join(" | ")}` : ""}`
            ).join("\n") || "No subagents found",
          }],
          details: { agents: agents.map(({ prompt: _prompt, ...agent }) => agent) },
        };
      }

      if (params.action === "status") {
        const selected = params.runId ? [runs.get(params.runId)].filter(Boolean) as ActiveRun[] : [...runs.values()];
        if (params.runId && !selected.length) throw new Error(`Unknown run '${params.runId}'`);
        return {
          content: [{ type: "text", text: selected.map(({ report }) =>
            `${report.id} — ${report.agent}: ${report.status}; report=${report.filePath}${report.questions?.length ? `\n${report.questions.map((question, index) => `  ${index + 1}. ${question}`).join("\n")}` : ""}`
          ).join("\n") || "No runs started in this Pi process" }],
          details: { runs: selected.map(({ report }) => report) },
        };
      }

      if (params.action === "resume") {
        if (!params.runId || !params.answer?.trim()) throw new Error("action=resume requires runId and answer");
        const run = runs.get(params.runId);
        const pending = continuations.get(params.runId);
        if (!run) throw new Error(`Unknown run '${params.runId}'`);
        if (run.report.status !== "waiting" || !pending) throw new Error(`Run ${params.runId} is not waiting for input`);
        continuations.delete(params.runId);
        resumeRunReport(run.report);
        const resumeSignal = AbortSignal.any([signal ?? new AbortController().signal, run.controller.signal]);
        const execution = executeRun(run, resumeSignal, () => pending.continuation.resume(params.answer!, resumeSignal));
        run.promise = execution.then(() => undefined, () => undefined);
        const result = await execution;
        if (result.status === "waiting") {
          return { content: [{ type: "text", text: formatParentRequest(run.report.agent, run.report.id, result.request) }], details: { run: run.report } };
        }
        const truncated = truncateHead(result.output);
        return { content: [{ type: "text", text: `${truncated.content}\n\n[Full report: ${run.report.filePath}]` }], details: { agent: run.report.agent, model: result.model, report: run.report.filePath } };
      }

      if (params.action === "stop") {
        if (!params.runId) throw new Error("action=stop requires runId");
        const run = runs.get(params.runId);
        if (!run) throw new Error(`Unknown run '${params.runId}'`);
        if (run.report.status !== "running" && run.report.status !== "waiting") return { content: [{ type: "text", text: `Run ${params.runId} is already ${run.report.status}` }] };
        run.controller.abort();
        if (run.report.status === "waiting") {
          cleanupRun(params.runId);
          finishRunReport(run.report, { status: "aborted", error: "Stopped while waiting for parent input" });
        } else {
          await run.promise;
        }
        return { content: [{ type: "text", text: `Stopped ${params.runId}; report=${run.report.filePath}` }] };
      }

      if (!params.agent || !params.task) throw new Error("action=run requires agent and task");
      const agent = resolveAgent(agents, params.agent);
      if (!agent) throw new Error(`Unknown subagent '${params.agent}'. Available: ${agents.map(({ name }) => name).join(", ")}`);
      if (agent.invalidTools?.length) throw new Error(`${agent.name} has unsupported tools: ${agent.invalidTools.join(", ")}`);
      const writes = agent.tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write");
      const report = startRunReport(REPORTS_DIRECTORY, agent.name, params.task, ctx.cwd);
      let releaseLock: (() => void) | undefined;
      try {
        releaseLock = writes ? acquireMutationLock(REPORTS_DIRECTORY, ctx.cwd, report.id) : undefined;
      } catch (error) {
        finishRunReport(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      const activeRun = trackRun(runs, report, signal, params.async === true);
      if (releaseLock) releases.set(report.id, releaseLock);
      refreshStatus?.();
      const execute = () => executeRun(activeRun, activeRun.signal, () => runAgent(agent, params.task!, ctx.cwd, activeRun.signal, ctx, pi, (event) => {
        if (captureRunMessage(activeRun.messages, event)) refreshStatus?.();
      }));

      if (params.async) {
        activeRun.promise = execute()
          .then((result) => {
            if (shuttingDown) return;
            if (result.status === "waiting") {
              const message = formatParentRequest(agent.name, report.id, result.request);
              ctx.ui.notify(`${agent.name} needs parent input`, "warning");
              pi.sendMessage({ customType: "subagent-parent-request", content: message, display: true }, { deliverAs: "steer", triggerTurn: true });
            } else {
              ctx.ui.notify(`${agent.name} completed: ${report.filePath}`, "info");
            }
          })
          .catch((error) => {
            if (!shuttingDown) ctx.ui.notify(`${agent.name} ${report.status}: ${error instanceof Error ? error.message : String(error)}`, "error");
          });
        return {
          content: [{ type: "text", text: `Started ${agent.name} asynchronously. Run ID: ${report.id}\nReport: ${report.filePath}` }],
          details: { run: report },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `${agent.name} is running…\nReport: ${report.filePath}` }],
        details: { agent: agent.name, report: report.filePath },
      });
      const execution = execute();
      activeRun.promise = execution.then(() => undefined, () => undefined);
      try {
        const result = await execution;
        if (result.status === "waiting") {
          return {
            content: [{ type: "text", text: formatParentRequest(agent.name, report.id, result.request) }],
            details: { agent: agent.name, model: result.model, report: report.filePath, run: report },
          };
        }
        const truncated = truncateHead(result.output);
        return {
          content: [{
            type: "text",
            text: truncated.content + `\n\n[Full report: ${report.filePath}]`,
          }],
          details: { agent: agent.name, model: result.model, report: report.filePath },
        };
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nReport: ${report.filePath}`);
      }
    },
  });
}
