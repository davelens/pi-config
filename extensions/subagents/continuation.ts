import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { THINKING_LEVELS, type AgentConfig } from "./agents.ts";
import type { ChildCheckpoint, RunReport } from "./reports.ts";

export function configHash(agent: AgentConfig): string {
  return createHash("sha256").update(JSON.stringify([
    agent.name, agent.prompt, agent.tools, agent.skills ?? [], agent.model ?? null,
    agent.thinking ?? null, agent.fallbackModels ?? [], agent.timeoutMs ?? null,
  ])).digest("hex");
}

export function transcriptHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateContinuation(report: RunReport, agent: AgentConfig, cwd: string, sessionsDirectory: string): ChildCheckpoint {
  if (report.status !== "aborted") throw new Error("Only a cancelled/interrupted child can be continued; stop it and wait for settlement first");
  const saved = report.checkpoint;
  if (!saved || !saved.sessionPath || !saved.sessionId || !saved.transcriptHash) throw new Error("This run has no saved continuation checkpoint");
  if (saved.configHash !== configHash(agent)) throw new Error("Agent configuration changed since cancellation; continuation refused");
  if (!THINKING_LEVELS.includes(saved.thinking as typeof THINKING_LEVELS[number])) throw new Error("Saved thinking level is invalid");
  if (typeof saved.model !== "string" || !saved.model.includes("/")) throw new Error("Saved model is invalid");
  if (realpathSync(cwd) !== realpathSync(report.cwd)) throw new Error("Continuation must use the original working directory");
  const path = realpathSync(saved.sessionPath);
  if (dirname(path) !== realpathSync(sessionsDirectory) || !path.endsWith(".jsonl") || !statSync(path).isFile()) throw new Error("Child session is outside the managed session directory");
  if (report.sessionPaths.at(-1) !== saved.sessionPath) throw new Error("Saved child session does not match the run");
  if (transcriptHash(path) !== saved.transcriptHash) throw new Error("Child session changed since this checkpoint; use its latest cancelled run instead");
  const entries = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const header = entries.shift();
  if (header?.type !== "session" || header.version !== 3 || header.id !== saved.sessionId || realpathSync(header.cwd) !== realpathSync(cwd)) throw new Error("Child session identity or working directory does not match");
  const ids = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || ids.has(entry.id) || typeof entry.type !== "string" || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error("Child session has corrupt entry links");
    ids.add(entry.id);
  }
  if (!entries.some((entry) => entry.type === "message" && entry.message?.role === "user") || entries.at(-1)?.id !== saved.leafId) throw new Error("Child session checkpoint is incomplete or stale");
  return { ...saved, sessionPath: path };
}

export function continuationPrompt(task: string): string {
  return `Continue the original assignment in this same child session after user cancellation. Preserve existing work and use the saved conversation; do not start the assignment over. An interrupted model request cannot be restored internally. An interrupted tool may have partially completed: inspect its effects before deciding whether it is safe to retry, and ask the user when uncertain. Do not blindly replay side-effecting tools.\n\nOriginal assignment:\n${task}`;
}
