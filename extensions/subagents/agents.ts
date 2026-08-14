import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const SUPPORTED_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write", "git_inspect", "ketch"]);
const MUTATION_TOOLS = new Set(["bash", "edit", "write"]);
export const FORBIDDEN_CHILD_SKILL = "pi-subagents";

export interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: ThinkingLevel;
  timeoutMs?: number;
  skills?: string[];
  aliases?: string[];
  invalidTools?: string[];
  warnings?: string[];
  prompt: string;
  filePath: string;
}

interface AgentOverride {
  description?: string;
  model?: string | null;
  fallbackModels?: string[];
  thinking?: ThinkingLevel;
  timeoutMs?: number;
  skills?: string[];
  tools?: string[];
}

function unquote(value: string): string {
  const quote = value[0];
  return quote && quote === value.at(-1) && (quote === '"' || quote === "'")
    ? value.slice(1, -1)
    : value;
}

export function parseAgent(content: string, filePath = ""): AgentConfig | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return;

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim()));
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) return;

  const thinking = fields.get("thinking");
  const tools = (fields.get("tools") ?? "read, grep, find, ls")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  const invalidTools = tools.filter((tool) => !SUPPORTED_TOOLS.has(tool));
  const skills = (fields.get("skills") ?? "").split(",").map((skill) => skill.trim()).filter(Boolean);
  const warnings = thinking && !THINKING_LEVELS.includes(thinking as ThinkingLevel)
    ? [`Invalid thinking level '${thinking}'${filePath ? ` in ${filePath}` : ""}`]
    : [];
  return {
    name,
    description,
    tools,
    ...(fields.get("model") ? { model: fields.get("model") } : {}),
    ...(THINKING_LEVELS.includes(thinking as ThinkingLevel) ? { thinking: thinking as ThinkingLevel } : {}),
    ...(skills.length ? { skills } : {}),
    ...(invalidTools.length ? { invalidTools } : {}),
    ...(warnings.length ? { warnings } : {}),
    prompt: match[2].trim(),
    filePath,
  };
}

function loadDirectory(directory: string): AgentConfig[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) return [];
    try {
      const filePath = join(directory, entry.name);
      const agent = parseAgent(readFileSync(filePath, "utf8"), filePath);
      return agent ? [agent] : [];
    } catch {
      return [];
    }
  });
}

function readSettings(path: string | undefined): {
  agentOverrides: Record<string, AgentOverride>;
  aliases: Record<string, string>;
} {
  if (!path) return { agentOverrides: {}, aliases: {} };
  try {
    const subagents = JSON.parse(readFileSync(path, "utf8")).subagents;
    return {
      agentOverrides: subagents?.agentOverrides ?? {},
      aliases: Object.fromEntries(Object.entries(subagents?.aliases ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    };
  } catch {
    return { agentOverrides: {}, aliases: {} };
  }
}

function applyOverrides(agents: Map<string, AgentConfig>, overrides: Record<string, AgentOverride>, allowMutationEscalation: boolean): void {
  for (const [name, override] of Object.entries(overrides)) {
    const agent = agents.get(name);
    if (!agent) continue;
    const next = { ...agent, ...override };
    if (override.model === null) delete next.model;
    else if (override.model !== undefined && typeof override.model !== "string") {
      next.model = agent.model;
      next.warnings = [...(next.warnings ?? []), "Model override must be a model name or null"];
    }
    if (!THINKING_LEVELS.includes(next.thinking as ThinkingLevel)) {
      if (override.thinking !== undefined) next.warnings = [...(agent.warnings ?? []), `Invalid thinking override '${override.thinking}'`];
      delete next.thinking;
    }
    if (typeof next.timeoutMs !== "number" || !Number.isFinite(next.timeoutMs) || next.timeoutMs <= 0 || next.timeoutMs > 2_147_483_647) delete next.timeoutMs;
    if (override.fallbackModels !== undefined) {
      if (Array.isArray(override.fallbackModels) && override.fallbackModels.every((model) => typeof model === "string")) {
        next.fallbackModels = [...new Set(override.fallbackModels.map((model) => model.trim()).filter(Boolean))];
      } else {
        next.fallbackModels = agent.fallbackModels;
        next.warnings = [...(next.warnings ?? []), "Fallback models override must be an array of model names"];
      }
    }
    if (override.skills !== undefined) {
      if (Array.isArray(override.skills) && override.skills.every((skill) => typeof skill === "string")) {
        next.skills = [...new Set(override.skills.map((skill) => skill.trim()).filter(Boolean))];
      } else {
        next.skills = agent.skills;
        next.warnings = [...(next.warnings ?? []), "Skills override must be an array of names"];
      }
    }
    if (override.tools !== undefined) {
      if (!Array.isArray(override.tools) || !override.tools.every((tool) => typeof tool === "string")) {
        next.tools = agent.tools;
        next.warnings = [...(next.warnings ?? []), "Tools override must be an array of tool names"];
      } else {
        const blocked = allowMutationEscalation
          ? []
          : override.tools.filter((tool) => MUTATION_TOOLS.has(tool) && !agent.tools.includes(tool));
        next.tools = override.tools.filter((tool) => !blocked.includes(tool));
        next.invalidTools = next.tools.filter((tool) => !SUPPORTED_TOOLS.has(tool));
        if (!next.invalidTools.length) delete next.invalidTools;
        if (blocked.length) next.warnings = [...(next.warnings ?? []), `Project override cannot grant mutation tools: ${blocked.join(", ")}`];
      }
    }
    agents.set(name, next);
  }
}

export function agentConfigurationIssues(agent: Pick<AgentConfig, "skills" | "tools">): string[] {
  return [
    ...(agent.skills?.includes(FORBIDDEN_CHILD_SKILL) ? [`${FORBIDDEN_CHILD_SKILL} cannot be used by subagents`] : []),
    ...(agent.skills?.length && !agent.tools.includes("read") ? ["configured skills require the read tool"] : []),
  ];
}

export function diagnoseAgentDefinitions(directory: string): string[] {
  if (!existsSync(directory)) return [`${directory}: directory is missing`];
  const diagnostics: string[] = [];
  const names = new Map<string, string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = join(directory, entry.name);
    try {
      const agent = parseAgent(readFileSync(filePath, "utf8"), filePath);
      if (!agent) {
        diagnostics.push(`${filePath}: invalid or missing frontmatter, name, or description`);
        continue;
      }
      const previous = names.get(agent.name);
      if (previous) diagnostics.push(`${filePath}: duplicate agent name '${agent.name}' (also ${previous})`);
      else names.set(agent.name, filePath);
      if (agent.invalidTools?.length) diagnostics.push(`${filePath}: unsupported tools: ${agent.invalidTools.join(", ")}`);
      diagnostics.push(...agentConfigurationIssues(agent).map((issue) => `${filePath}: ${issue}`), ...(agent.warnings ?? []));
    } catch (error) {
      diagnostics.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return diagnostics;
}

export function discoverAgents(options: {
  agentsDirectory: string;
  settingsPaths: string[];
  projectSettingsPath?: string;
}): AgentConfig[] {
  const agents = new Map<string, AgentConfig>();
  const aliases = new Map<string, string>();
  for (const agent of loadDirectory(options.agentsDirectory)) agents.set(agent.name, agent);
  for (const settingsPath of options.settingsPaths) {
    const settings = readSettings(settingsPath);
    applyOverrides(agents, settings.agentOverrides, settingsPath !== options.projectSettingsPath);
    for (const [alias, target] of Object.entries(settings.aliases)) aliases.set(alias, target);
  }
  for (const [alias, target] of aliases) {
    if (agents.has(alias)) continue;
    const agent = agents.get(target);
    if (agent) agent.aliases = [...(agent.aliases ?? []), alias];
  }
  return [...agents.values()];
}

export function resolveAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
  return agents.find((agent) => agent.name === name) ?? agents.find((agent) => agent.aliases?.includes(name));
}
