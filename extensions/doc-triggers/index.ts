import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type Doc = { path: string; paths: string[] };
type Snapshot = { head?: string; hashes: Map<string, string> };
type Exec = ExtensionAPI["exec"];

// Memory is project-wide, so only these files (plus `paths:` frontmatter) tie it to code.
const MEMORY_DEFAULTS: Record<string, string[]> = {
  "docs/memory/architecture.md": ["Gemfile", "package.json"],
  "docs/memory/key-commands.md": ["bin/", "lib/tasks/", "Rakefile", "Procfile", "Procfile.dev"],
};
const NO_ENTRY_NEEDED = /^(spec|test|docs|log|tmp|vendor|node_modules|coverage)\//;
const CODE_PATH = /`([\w.@-]+(?:\/[\w.@-]+)+\/?)(?::\d+)?`/g;
const WIKI = "docs/wiki/";

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

export function frontmatterPaths(text: string): string[] {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return [];
  const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");
  const inline = frontmatter.match(/^paths:\s*\[(.*)\]\s*$/m);
  if (inline) return inline[1].split(",").map(unquote).filter(Boolean);
  const block = frontmatter.match(/^paths:\s*\r?\n((?:[ \t]+-[ \t]+.*(?:\r?\n|$))+)/m);
  return block ? [...block[1].matchAll(/-[ \t]+(.+)/g)].map((match) => unquote(match[1])) : [];
}

export function loadDocs(root: string): Doc[] {
  // The roadmap is a history log; the paths it names do not make it the owner of that code.
  const wikiFiles = markdownFiles(join(root, WIKI)).filter((file) => !relative(root, file).startsWith(`${WIKI}roadmap/`));
  const wiki = wikiFiles.map((file) => {
    const text = readFileSync(file, "utf8");
    // Backticked paths count only when they exist, which drops prose such as `Order::STATUSES`.
    const named = [...text.matchAll(CODE_PATH)].flatMap(([, path]) => {
      const full = join(root, path);
      if (!existsSync(full)) return [];
      return [statSync(full).isDirectory() ? path.replace(/\/?$/, "/") : path.replace(/\/$/, "")];
    });
    return { path: relative(root, file), paths: [...new Set([...frontmatterPaths(text), ...named])] };
  });
  const memory = markdownFiles(join(root, "docs/memory")).map((file) => {
    const path = relative(root, file);
    return { path, paths: [...frontmatterPaths(readFileSync(file, "utf8")), ...(MEMORY_DEFAULTS[path] ?? [])] };
  });
  return [...wiki, ...memory].filter((doc) => doc.paths.length);
}

// The most specific match wins: the file itself, then its closest named directory, then
// (for new files) the one wiki entry that names a sibling. Several sibling owners means no owner.
export function coveringDocs(docs: Doc[], file: string, siblings = false): string[] {
  const exact = docs.filter((doc) => doc.paths.includes(file));
  if (exact.length) return exact.map((doc) => doc.path);

  let longest = 0;
  let byDirectory: Doc[] = [];
  for (const doc of docs) {
    for (const path of doc.paths) {
      if (!path.endsWith("/") || !file.startsWith(path) || path.length < longest) continue;
      if (path.length > longest) byDirectory = [];
      longest = path.length;
      if (!byDirectory.includes(doc)) byDirectory.push(doc);
    }
  }
  if (byDirectory.length) return byDirectory.map((doc) => doc.path);
  if (!siblings) return [];

  const directory = dirname(file);
  const bySibling = docs.filter((doc) =>
    doc.path.startsWith(WIKI) && doc.paths.some((path) => !path.endsWith("/") && dirname(path) === directory),
  );
  return bySibling.length === 1 ? [bySibling[0].path] : [];
}

function mergeDocs(...lists: Doc[][]): Doc[] {
  const merged = new Map<string, Set<string>>();
  for (const doc of lists.flat()) {
    const paths = merged.get(doc.path) ?? new Set();
    doc.paths.forEach((path) => paths.add(path));
    merged.set(doc.path, paths);
  }
  return [...merged].map(([path, paths]) => ({ path, paths: [...paths] }));
}

/** Builds the settle reminder and records what it mentions in `reminded`, so each item is raised once per session. */
export function settleReminder(docs: Doc[], changed: Set<string>, added: Set<string>, reminded: Set<string>): string | undefined {
  const stale = new Map<string, string[]>();
  const uncovered: string[] = [];

  for (const file of [...changed].sort()) {
    if (file.startsWith("docs/")) continue;
    const covering = coveringDocs(docs, file, added.has(file));
    for (const doc of covering.filter((path) => !changed.has(path))) {
      const key = `${doc}\0${file}`;
      if (reminded.has(key)) continue;
      reminded.add(key);
      stale.set(doc, [...(stale.get(doc) ?? []), file]);
    }
    if (!covering.length && added.has(file) && !NO_ENTRY_NEEDED.test(file) && !reminded.has(file)) {
      reminded.add(file);
      uncovered.push(file);
    }
  }
  if (!stale.size && !uncovered.length) return undefined;

  const code = (paths: string[]) => paths.map((path) => `\`${path}\``).join(", ");
  return [
    "Docs check before you finish:",
    ...[...stale].map(([doc, files]) => `- \`${doc}\` covers files that you changed, but you did not update it: ${code(files)}`),
    ...(uncovered.length ? [`- No wiki entry covers these new files: ${code(uncovered)}`] : []),
    "For each item, apply the update rules of the `project-wiki` or `project-memory` skill: update the doc, add the new paths to an entry, propose a new entry, or tell the user in one sentence why no update is necessary.",
  ].join("\n");
}

async function git(exec: Exec, root: string, args: string[]): Promise<string | undefined> {
  const result = await exec("git", args, { cwd: root, timeout: 10_000 });
  return result.code === 0 ? result.stdout : undefined;
}

async function worktreeStatus(exec: Exec, root: string) {
  const out = await git(exec, root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (out === undefined) return undefined;
  return out.split("\0").filter(Boolean).map((line) => ({
    path: line.slice(3),
    isNew: line.startsWith("??") || line[0] === "A",
  }));
}

async function hashFiles(exec: Exec, root: string, paths: string[]): Promise<Map<string, string>> {
  const existing = paths.filter((path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile());
  const hashes = new Map(paths.map((path) => [path, "missing"]));
  if (!existing.length) return hashes;
  const out = await git(exec, root, ["hash-object", "--", ...existing]);
  out?.trim().split("\n").forEach((hash, index) => hashes.set(existing[index], hash));
  return hashes;
}

async function snapshot(exec: Exec, root: string): Promise<Snapshot | undefined> {
  const status = await worktreeStatus(exec, root);
  if (!status) return undefined;
  const head = (await git(exec, root, ["rev-parse", "HEAD"]))?.trim();
  return { head, hashes: await hashFiles(exec, root, status.map(({ path }) => path)) };
}

/** Files that changed since `before`, through commits or the worktree. Untouched dirty files of the user stay out. */
async function changesSince(exec: Exec, root: string, before: Snapshot) {
  const changed = new Set<string>();
  const added = new Set<string>();
  const head = (await git(exec, root, ["rev-parse", "HEAD"]))?.trim();
  if (before.head && head && head !== before.head) {
    const parts = (await git(exec, root, ["diff", "--name-status", "--no-renames", "-z", before.head, head]))?.split("\0") ?? [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      changed.add(parts[index + 1]);
      if (parts[index] === "A") added.add(parts[index + 1]);
    }
  }
  const status = (await worktreeStatus(exec, root)) ?? [];
  const now = await hashFiles(exec, root, status.map(({ path }) => path));
  for (const { path, isNew } of status) {
    if (before.hashes.get(path) === now.get(path)) continue;
    changed.add(path);
    if (isNew) added.add(path);
  }
  return { changed, added };
}

export default function docTriggers(pi: ExtensionAPI) {
  let seen = new Set<string>();
  let reminded = new Set<string>();
  let docs: Doc[] = [];
  let before: Snapshot | undefined;
  // Notes from nested calls (codemode) wait for the model-issued call, whose result the model always sees.
  const pending = new Map<string, string[]>();

  const active = (root: string) => existsSync(join(root, WIKI)) || existsSync(join(root, "docs/memory"));

  pi.on("session_start", () => {
    seen = new Set();
    reminded = new Set();
  });

  pi.on("agent_start", async (_event, ctx) => {
    before = undefined;
    if (!active(ctx.cwd)) return;
    docs = loadDocs(ctx.cwd);
    before = await snapshot(pi.exec.bind(pi), ctx.cwd);
  });

  const lookupNote = (toolName: string, input: Record<string, unknown>, cwd: string): string | undefined => {
    if (!["read", "edit", "write"].includes(toolName) || typeof input.path !== "string") return;
    const file = relative(cwd, isAbsolute(input.path) ? input.path : resolve(cwd, input.path));
    if (file.startsWith("..")) return;
    if (file.startsWith(WIKI)) {
      seen.add(file);
      return;
    }
    const unread = coveringDocs(docs, file).filter((doc) => doc.startsWith(WIKI) && !seen.has(doc));
    if (!unread.length) return;
    unread.forEach((doc) => seen.add(doc));
    const list = unread.map((doc) => `\`${doc}\``).join(", ");
    return `[docs] ${list} ${unread.length > 1 ? "cover" : "covers"} \`${file}\`. Read ${unread.length > 1 ? "them" : "it"} before you change it.`;
  };

  pi.on("tool_result", (event, ctx) => {
    const notes = pending.get(event.toolCallId) ?? [];
    pending.delete(event.toolCallId);
    const note = lookupNote(event.toolName, event.input, ctx.cwd);
    if (note) notes.push(note);
    if (!notes.length) return;
    if (event.parentToolCallId) {
      pending.set(event.parentToolCallId, [...(pending.get(event.parentToolCallId) ?? []), ...notes]);
      return;
    }
    return { content: [...event.content, ...notes.map((text) => ({ type: "text" as const, text }))] };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!before || event.outcome !== "completed" || !event.context.canContinue) return;
    const { changed, added } = await changesSince(pi.exec.bind(pi), ctx.cwd, before);
    const content = settleReminder(mergeDocs(docs, loadDocs(ctx.cwd)), changed, added, reminded);
    if (!content) return;
    return { entries: [...event.entries, { type: "custom_message", customType: "doc-triggers", content, display: true }], continue: true };
  });
}
