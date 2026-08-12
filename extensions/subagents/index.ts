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
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { ensureDefaultAgents } from "./agent-files.ts";
import { SubagentManager } from "./manager.ts";
import { acquireMutationLock, finishRunReport, startRunReport, type RunReport } from "./reports.ts";

const DEFAULT_AGENTS = fileURLToPath(new URL("./default-agents", import.meta.url));
const AGENTS_DIRECTORY = join(homedir(), ".config", "agents", "pi");
const REPORTS_DIRECTORY = join(AGENTS_DIRECTORY, "reports");

interface AgentResult {
  output: string;
  model: string;
}

interface ActiveRun {
  report: RunReport;
  controller: AbortController;
  promise: Promise<void>;
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
  return discoverAgents({ agentsDirectory: AGENTS_DIRECTORY, settingsPaths: settingsFor(ctx) });
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

async function runAttempt(agent: AgentConfig, task: string, cwd: string, modelName: string | undefined, signal: AbortSignal, ctx: ExtensionContext): Promise<AgentResult> {
  const model = resolveModel(modelName, agent, ctx);
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, signal });
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error(`Provider '${model.provider}' is unavailable`);
  modelRuntime.registerNativeProvider(provider);

  const settingsManager = SettingsManager.inMemory({
    httpIdleTimeoutMs: 0,
    retry: { enabled: true, maxRetries: 2 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => model.provider === "claude-bridge"
      ? `${ctx.getSystemPrompt()}\n\n# Subagent role\n${agent.prompt}`
      : agent.prompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    thinkingLevel: agent.thinking,
    tools: agent.tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  const abort = () => void session.abort();
  signal.addEventListener("abort", abort, { once: true });

  try {
    signal.throwIfAborted();
    await session.prompt(task);
    return {
      output: textFromLastAssistantMessage(session.messages),
      model: `${model.provider}/${model.id}`,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    session.dispose();
  }
}

async function runAgent(agent: AgentConfig, task: string, cwd: string, signal: AbortSignal, ctx: ExtensionContext): Promise<AgentResult> {
  const candidates = [...new Set([agent.model, ...(agent.fallbackModels ?? [])])];
  const errors: string[] = [];
  for (const candidate of candidates.length ? candidates : [undefined]) {
    try {
      return await runAttempt(agent, task, cwd, candidate, signal, ctx);
    } catch (error) {
      if (signal.aborted) throw error;
      errors.push(`${candidate ?? "parent model"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`All models failed for ${agent.name}:\n${errors.join("\n")}`);
}

export default function subagents(pi: ExtensionAPI) {
  ensureDefaultAgents(DEFAULT_AGENTS, AGENTS_DIRECTORY);
  const runs = new Map<string, ActiveRun>();
  let shuttingDown = false;

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    for (const run of runs.values()) {
      if (run.report.status === "running") run.controller.abort();
    }
    await Promise.allSettled([...runs.values()].map(({ promise }) => promise));
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
      "Use separate subagent calls for independent parallel tasks; asynchronous writers are limited to one per working directory.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "run", "status", "stop"] as const),
      agent: Type.Optional(Type.String({ description: "Agent name for action=run" })),
      task: Type.Optional(Type.String({ description: "Self-contained task for action=run" })),
      async: Type.Optional(Type.Boolean({ description: "Return immediately and run in the background" })),
      runId: Type.Optional(Type.String({ description: "Run ID for action=status or action=stop" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const agents = agentsFor(ctx);

      if (params.action === "list") {
        return {
          content: [{
            type: "text",
            text: agents.map((agent) =>
              `${agent.name} — ${agent.description}; model=${agent.model ?? "parent"}${agent.fallbackModels?.length ? `; fallbacks=${agent.fallbackModels.join(",")}` : ""}; tools=${agent.tools.join(",")}`
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
            `${report.id} — ${report.agent}: ${report.status}; report=${report.filePath}`
          ).join("\n") || "No runs started in this Pi process" }],
          details: { runs: selected.map(({ report }) => report) },
        };
      }

      if (params.action === "stop") {
        if (!params.runId) throw new Error("action=stop requires runId");
        const run = runs.get(params.runId);
        if (!run) throw new Error(`Unknown run '${params.runId}'`);
        if (run.report.status !== "running") return { content: [{ type: "text", text: `Run ${params.runId} is already ${run.report.status}` }] };
        run.controller.abort();
        await run.promise;
        return { content: [{ type: "text", text: `Stopped ${params.runId}; report=${run.report.filePath}` }] };
      }

      if (!params.agent || !params.task) throw new Error("action=run requires agent and task");
      const agent = agents.find(({ name }) => name === params.agent);
      if (!agent) throw new Error(`Unknown subagent '${params.agent}'. Available: ${agents.map(({ name }) => name).join(", ")}`);
      const writes = agent.tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write");
      const report = startRunReport(REPORTS_DIRECTORY, agent.name, params.task, ctx.cwd);
      let releaseLock: (() => void) | undefined;
      try {
        releaseLock = params.async && writes ? acquireMutationLock(REPORTS_DIRECTORY, ctx.cwd, report.id) : undefined;
      } catch (error) {
        finishRunReport(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      const controller = params.async ? new AbortController() : undefined;
      const runSignal = controller?.signal ?? signal ?? new AbortController().signal;
      const execute = async () => {
        try {
          const result = await runAgent(agent, params.task!, ctx.cwd, runSignal, ctx);
          runSignal.throwIfAborted();
          finishRunReport(report, { status: "completed", model: result.model, output: result.output });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          finishRunReport(report, { status: runSignal.aborted ? "aborted" : "failed", error: message });
          throw error;
        } finally {
          releaseLock?.();
        }
      };

      if (params.async) {
        const promise = execute()
          .then(() => {
            if (!shuttingDown) ctx.ui.notify(`${agent.name} completed: ${report.filePath}`, "info");
          })
          .catch((error) => {
            if (!shuttingDown) ctx.ui.notify(`${agent.name} ${report.status}: ${error instanceof Error ? error.message : String(error)}`, "error");
          });
        runs.set(report.id, { report, controller: controller!, promise });
        return {
          content: [{ type: "text", text: `Started ${agent.name} asynchronously. Run ID: ${report.id}\nReport: ${report.filePath}` }],
          details: { run: report },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `${agent.name} is running…\nReport: ${report.filePath}` }],
        details: { agent: agent.name, report: report.filePath },
      });
      try {
        const result = await execute();
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
