import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REQUIRED_SKILL_RE = /Load\s*\+\s*read\s+`([^`]+)`\s+skill(?:\s+if\s+(.+))?/i;
const LOAD_SKILLS_HEADER_RE = /^\s*(?:[-*+]|\d+\.)?\s*Load skills:\s*$/i;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function findUp(start: string, fileName: string): string[] {
  const results: string[] = [];
  let current = resolve(start);

  while (true) {
    const candidate = join(current, fileName);
    if (existsSync(candidate)) results.push(candidate);

    const parent = dirname(current);
    if (parent === current) return results.reverse();
    current = parent;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function candidateSkillFiles(cwd: string, skillName: string): string[] {
  const parents = unique([cwd, ...findUp(cwd, "AGENTS.md").map(dirname)]);
  const localCandidates = parents.flatMap((dir) => [
    join(dir, ".agents", "skills", skillName, "SKILL.md"),
    join(dir, ".pi", "skills", skillName, "SKILL.md"),
  ]);

  return [
    ...localCandidates,
    join(homedir(), ".pi", "agent", "skills", skillName, "SKILL.md"),
    join(homedir(), ".agents", "skills", skillName, "SKILL.md"),
    join(homedir(), ".config", "agents", "skills", "pi", skillName, "SKILL.md"),
  ];
}

function loadSkill(cwd: string, skillName: string): { path: string; content: string } | undefined {
  for (const path of candidateSkillFiles(cwd, skillName)) {
    const content = readText(expandHome(path));
    if (content !== undefined) return { path: expandHome(path), content };
  }
  return undefined;
}

function conditionPasses(cwd: string, condition: string | undefined): boolean {
  if (!condition) return true;

  const normalized = condition.toLowerCase();
  if (normalized.includes("docs/wiki")) {
    return existsSync(join(cwd, "docs", "wiki"));
  }

  // Unknown AGENTS.md conditions are intentionally conservative: do not load.
  return false;
}

function parseSkillListItem(text: string): { skillName: string; condition?: string } | undefined {
  const cleaned = text
    .replace(/\s+#.*$/, "")
    .replace(/^`([^`]+)`(.*)$/, "$1$2")
    .replace(/\s+skill\s*$/i, "")
    .trim();
  if (!cleaned) return undefined;

  const conditional = cleaned.match(/^([^\s]+)\s+if\s+(.+)$/i);
  if (conditional) {
    const [, skillName, condition] = conditional;
    return skillName ? { skillName, condition } : undefined;
  }

  const skillName = cleaned.split(/\s+/)[0];
  return skillName ? { skillName } : undefined;
}

type StartupSkillRequest = {
  skillName: string;
  condition: string | undefined;
  loaded: boolean;
};

function startupSkillRequestsFromAgents(contextFiles: Array<{ path?: string; content?: string }> | undefined, cwd: string): StartupSkillRequest[] {
  const requests: StartupSkillRequest[] = [];
  const seen = new Set<string>();

  function add(skillName: string | undefined, condition: string | undefined): void {
    if (!skillName) return;
    const key = `${skillName}\0${condition ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ skillName, condition, loaded: conditionPasses(cwd, condition) });
  }

  for (const file of contextFiles ?? []) {
    if (!file.path?.endsWith("AGENTS.md") && !file.path?.endsWith("CLAUDE.md")) continue;

    let inLoadSkillsList = false;
    for (const line of (file.content ?? "").split(/\r?\n/)) {
      const legacyMatch = line.match(REQUIRED_SKILL_RE);
      if (legacyMatch) {
        const [, skillName, condition] = legacyMatch;
        add(skillName, condition);
        continue;
      }

      if (LOAD_SKILLS_HEADER_RE.test(line)) {
        inLoadSkillsList = true;
        continue;
      }

      if (!inLoadSkillsList) continue;
      if (!line.trim()) continue;

      const listMatch = line.match(LIST_ITEM_RE);
      if (!listMatch) {
        inLoadSkillsList = false;
        continue;
      }

      const item = parseSkillListItem(listMatch[1] ?? "");
      if (item) add(item.skillName, item.condition);
    }
  }

  return requests;
}

function requiredSkillsFromAgents(contextFiles: Array<{ path?: string; content?: string }> | undefined, cwd: string): string[] {
  return unique(startupSkillRequestsFromAgents(contextFiles, cwd)
    .filter((request) => request.loaded)
    .map((request) => request.skillName));
}

function memoryBaseline(cwd: string): Array<{ path: string; content: string }> {
  const memoryDir = join(cwd, "docs", "memory");
  const paths = [
    join(memoryDir, "index.md"),
    join(memoryDir, "architecture.md"),
    join(memoryDir, "coding-standards.md"),
  ];

  return paths.flatMap((path) => {
    const content = readText(path);
    return content === undefined ? [] : [{ path, content }];
  });
}

function wikiBaseline(cwd: string): Array<{ path: string; content: string }> {
  const path = join(cwd, "docs", "wiki", "index.md");
  const content = readText(path);
  return content === undefined ? [] : [{ path, content }];
}

function buildStartupContext(event: { systemPromptOptions?: { contextFiles?: Array<{ path?: string; content?: string }> } }, cwd: string): string | undefined {
  const requests = startupSkillRequestsFromAgents(event.systemPromptOptions?.contextFiles, cwd);
  const requiredSkills = unique(requests
    .filter((request) => request.loaded)
    .map((request) => request.skillName));
  if (requiredSkills.length === 0) return undefined;

  const sections: string[] = [];
  sections.push("<startup_skill_loader>");
  sections.push("CRITICAL: The Pi startup-skill-loader extension has already loaded the startup skills below into this system prompt before the assistant started.");
  sections.push("Treat every <skill> and baseline document in this block as already read. Do not manually reload these files unless the user explicitly asks you to inspect the source files again.");
  sections.push("If the user asks whether startup skills loaded, answer from this manifest: loaded skills are loaded; skipped skills were intentionally skipped because their AGENTS.md condition was false. Do not claim the loaded skills were not loaded.");
  sections.push("\n<startup_skill_manifest>");
  for (const request of requests) {
    const condition = request.condition ? ` condition=${JSON.stringify(request.condition)}` : "";
    sections.push(`<skill_request name=${JSON.stringify(request.skillName)} status=${JSON.stringify(request.loaded ? "loaded" : "skipped")}${condition} />`);
  }
  sections.push("</startup_skill_manifest>");

  for (const skillName of requiredSkills) {
    const loaded = loadSkill(cwd, skillName);
    if (!loaded) {
      sections.push(`\n<missing_skill name=${JSON.stringify(skillName)} />`);
      continue;
    }

    sections.push(`\n<skill name=${JSON.stringify(skillName)} path=${JSON.stringify(loaded.path)}>\n${loaded.content}\n</skill>`);

    if (skillName === "project-memory") {
      for (const file of memoryBaseline(cwd)) {
        sections.push(`\n<project_memory path=${JSON.stringify(file.path)}>\n${file.content}\n</project_memory>`);
      }
    }

    if (skillName === "project-wiki") {
      for (const file of wikiBaseline(cwd)) {
        sections.push(`\n<project_wiki path=${JSON.stringify(file.path)}>\n${file.content}\n</project_wiki>`);
      }
    }
  }

  sections.push("</startup_skill_loader>");
  return sections.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const startupContext = buildStartupContext(event, ctx.cwd);
    if (!startupContext) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${startupContext}`,
    };
  });

  pi.registerCommand("startup-skills", {
    description: "Show startup skills loaded from AGENTS.md rules",
    handler: async (_args, ctx) => {
      const options = ctx.getSystemPromptOptions();
      const requests = startupSkillRequestsFromAgents(options.contextFiles, ctx.cwd);
      const lines = requests.length === 0
        ? ["No AGENTS.md startup skill rules found."]
        : requests.map((request) => {
          if (!request.loaded) {
            const condition = request.condition ? ` (${request.condition})` : "";
            return `${request.skillName}: skipped${condition}`;
          }

          const loaded = loadSkill(ctx.cwd, request.skillName);
          return loaded ? `${request.skillName}: loaded from ${loaded.path}` : `${request.skillName}: missing`;
        });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
