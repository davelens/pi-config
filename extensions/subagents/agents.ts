import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: ThinkingLevel;
  prompt: string;
  filePath: string;
}

interface AgentOverride {
  description?: string;
  model?: string | null;
  fallbackModels?: string[];
  thinking?: ThinkingLevel;
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
  return {
    name,
    description,
    tools: (fields.get("tools") ?? "read, grep, find, ls")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
    ...(fields.get("model") ? { model: fields.get("model") } : {}),
    ...(THINKING_LEVELS.includes(thinking as ThinkingLevel) ? { thinking: thinking as ThinkingLevel } : {}),
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

function readOverrides(path: string | undefined): Record<string, AgentOverride> {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")).subagents?.agentOverrides ?? {};
  } catch {
    return {};
  }
}

function applyOverrides(agents: Map<string, AgentConfig>, overrides: Record<string, AgentOverride>): void {
  for (const [name, override] of Object.entries(overrides)) {
    const agent = agents.get(name);
    if (!agent) continue;
    const next = { ...agent, ...override };
    if (override.model === null) delete next.model;
    if (!THINKING_LEVELS.includes(next.thinking as ThinkingLevel)) delete next.thinking;
    agents.set(name, next);
  }
}

export function discoverAgents(options: {
  agentsDirectory: string;
  settingsPaths: string[];
}): AgentConfig[] {
  const agents = new Map<string, AgentConfig>();
  for (const agent of loadDirectory(options.agentsDirectory)) agents.set(agent.name, agent);
  for (const settingsPath of options.settingsPaths) applyOverrides(agents, readOverrides(settingsPath));
  return [...agents.values()];
}
