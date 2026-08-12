import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function ensureDefaultAgents(defaultsDirectory: string, agentsDirectory: string): void {
  if (existsSync(agentsDirectory)) return;
  mkdirSync(dirname(agentsDirectory), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(agentsDirectory), ".pi-agents-"));
  try {
    for (const entry of readdirSync(defaultsDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        copyFileSync(join(defaultsDirectory, entry.name), join(temporaryDirectory, entry.name));
      }
    }
    renameSync(temporaryDirectory, agentsDirectory);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function restoreDefaultAgents(defaultsDirectory: string, agentsDirectory: string): void {
  mkdirSync(agentsDirectory, { recursive: true });
  for (const entry of readdirSync(agentsDirectory, { withFileTypes: true })) {
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) unlinkSync(join(agentsDirectory, entry.name));
  }
  for (const entry of readdirSync(defaultsDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      copyFileSync(join(defaultsDirectory, entry.name), join(agentsDirectory, entry.name));
    }
  }
}

export function agentDefinitionParts(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error("Agent file has no valid frontmatter block");
  return { frontmatter: match[1], body: match[2] };
}

export function replaceAgentBody(content: string, body: string): string {
  const parts = agentDefinitionParts(content);
  return `${parts.frontmatter}${body.replace(/\s+$/, "")}\n`;
}

export function withEffectiveSettings(content: string, agent: {
  description: string;
  model?: string;
  fallbackModels?: string[];
  thinking?: string;
  tools: string[];
}): string {
  const parts = agentDefinitionParts(content);
  let frontmatter = parts.frontmatter;
  const fields = new Map<string, string | undefined>([
    ["description", agent.description],
    ["model", agent.model],
    ["fallbackModels", agent.fallbackModels?.join(", ")],
    ["thinking", agent.thinking],
    ["tools", agent.tools.length ? agent.tools.join(", ") : "[]"],
  ]);
  for (const [name, value] of fields) {
    const pattern = new RegExp(`^${name}:\\s*.*\\r?\\n`, "m");
    frontmatter = frontmatter.replace(pattern, "");
    if (value !== undefined) frontmatter = frontmatter.replace(/---\r?\n$/, `${name}: ${JSON.stringify(value)}\n---\n`);
  }
  return frontmatter + parts.body;
}

function replaceAgentName(content: string, name: string): string {
  const parts = agentDefinitionParts(content);
  if (!/^name:\s*.+$/m.test(parts.frontmatter)) throw new Error("Agent frontmatter has no name");
  return `${parts.frontmatter.replace(/^name:\s*.+$/m, `name: ${name}`)}${parts.body}`;
}

export function createAgentDefinition(directory: string, name: string): string {
  validateName(name);
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, `${name}.md`);
  if (existsSync(filePath)) throw new Error(`Agent file already exists: ${filePath}`);
  writeFileSync(filePath, `---\nname: ${name}\ndescription: Custom subagent\nthinking: medium\ntools: read, grep, find, ls\n---\nYou are ${name}.\n`, { flag: "wx" });
  return filePath;
}

export function deleteAgentDefinition(filePath: string): void {
  unlinkSync(filePath);
}

export function renameAgentDefinition(filePath: string, name: string): string {
  validateName(name);
  const target = join(dirname(filePath), `${name}.md`);
  if (target === filePath) return filePath;
  if (existsSync(target)) throw new Error(`Agent file already exists: ${target}`);

  const updated = replaceAgentName(readFileSync(filePath, "utf8"), name);
  renameSync(filePath, target);
  try {
    writeFileSync(target, updated);
  } catch (error) {
    renameSync(target, filePath);
    throw error;
  }
  return target;
}

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new Error("Use lowercase letters, numbers, and hyphens only");
}
