import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type StartupSkillRequest = {
  name: string;
  condition?: string;
  active: boolean;
};

type LoadedSkill = { path: string; content: string };

const DIRECTIVE_RE = /^\s*(?:[-*+]|\d+\.)\s+Load(?:\s*\+\s*read)?\s+`?([a-z0-9-]+)`?\s+skill(?:\s+if\s+(.+))?\s*$/i;
const HEADER_RE = /^\s*(?:[-*+]|\d+\.)?\s*Load skills:\s*$/i;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+`?([a-z0-9-]+)`?(?:\s+skill)?(?:\s+if\s+(.+))?\s*$/i;

const BASELINES: Record<string, { tag: string; paths: string[] }> = {
  "project-memory": {
    tag: "project_memory",
    paths: ["docs/memory/index.md", "docs/memory/architecture.md", "docs/memory/coding-standards.md"],
  },
  "project-wiki": { tag: "project_wiki", paths: ["docs/wiki/index.md"] },
};

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function conditionPasses(cwd: string, condition?: string): boolean {
  if (!condition) return true;
  return condition.toLowerCase().includes("docs/wiki") && existsSync(join(cwd, "docs", "wiki"));
}

export function startupSkillRequests(
  contextFiles: BuildSystemPromptOptions["contextFiles"],
  cwd: string,
): StartupSkillRequest[] {
  const requests: StartupSkillRequest[] = [];
  const seen = new Set<string>();

  const add = (name: string, condition?: string) => {
    condition = condition?.trim();
    const key = `${name}\0${condition ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ name, condition, active: conditionPasses(cwd, condition) });
  };

  for (const file of contextFiles ?? []) {
    if (!/(?:AGENTS|CLAUDE)\.md$/.test(file.path)) continue;

    let inList = false;
    for (const line of file.content.split(/\r?\n/)) {
      const directive = line.match(DIRECTIVE_RE);
      if (directive?.[1]) {
        add(directive[1], directive[2]);
        continue;
      }

      if (HEADER_RE.test(line)) {
        inList = true;
        continue;
      }

      if (!inList || !line.trim()) continue;
      const item = line.match(LIST_ITEM_RE);
      if (!item?.[1]) {
        inList = false;
        continue;
      }
      add(item[1], item[2]);
    }
  }

  return requests;
}

function loadSkill(options: BuildSystemPromptOptions, name: string): LoadedSkill | undefined {
  const path = options.skills?.find((skill) => skill.name === name)?.filePath;
  if (!path) return undefined;
  const content = readText(path);
  return content === undefined ? undefined : { path, content };
}

function baselineSections(cwd: string, skillName: string): string[] {
  const baseline = BASELINES[skillName];
  if (!baseline) return [];

  return baseline.paths.flatMap((relativePath) => {
    const path = join(cwd, relativePath);
    const content = readText(path);
    return content === undefined ? [] : [`<${baseline.tag} path=${JSON.stringify(path)}>\n${content}\n</${baseline.tag}>`];
  });
}

export function buildStartupContext(options: BuildSystemPromptOptions, cwd = options.cwd): string | undefined {
  const requests = startupSkillRequests(options.contextFiles, cwd);
  const names = [...new Set(requests.filter(({ active }) => active).map(({ name }) => name))];
  if (names.length === 0) return undefined;

  const loaded = new Map(names.map((name) => [name, loadSkill(options, name)]));
  const sections = [
    "<startup_skill_loader>",
    "CRITICAL: Skills and baseline documents marked loaded below are already read and active. Follow them without rereading their source files.",
    "<startup_skill_manifest>",
    ...requests.map(({ name, condition, active }) => {
      const status = active ? (loaded.get(name) ? "loaded" : "missing") : "skipped";
      const suffix = condition ? ` condition=${JSON.stringify(condition)}` : "";
      return `<skill_request name=${JSON.stringify(name)} status=${JSON.stringify(status)}${suffix} />`;
    }),
    "</startup_skill_manifest>",
  ];

  for (const name of names) {
    const skill = loaded.get(name);
    if (!skill) continue;
    sections.push(
      `<skill name=${JSON.stringify(name)} path=${JSON.stringify(skill.path)}>\n${skill.content}\n</skill>`,
      ...baselineSections(cwd, name),
    );
  }

  sections.push("</startup_skill_loader>");
  return sections.join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const startupContext = buildStartupContext(event.systemPromptOptions, ctx.cwd);
    if (startupContext) return { systemPrompt: `${event.systemPrompt}\n\n${startupContext}` };
  });

  pi.registerCommand("startup-skills", {
    description: "Show startup skills loaded from AGENTS.md rules",
    handler: async (_args, ctx) => {
      const options = ctx.getSystemPromptOptions();
      const lines = startupSkillRequests(options.contextFiles, ctx.cwd).map(({ name, condition, active }) => {
        if (!active) return `${name}: skipped${condition ? ` (${condition})` : ""}`;
        const skill = loadSkill(options, name);
        return skill ? `${name}: loaded from ${skill.path}` : `${name}: missing`;
      });
      ctx.ui.notify(lines.join("\n") || "No AGENTS.md startup skill rules found.", "info");
    },
  });
}
