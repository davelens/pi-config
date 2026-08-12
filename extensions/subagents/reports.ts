import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type RunStatus = "running" | "completed" | "failed" | "aborted";

export interface RunReport {
  id: string;
  agent: string;
  task: string;
  cwd: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  model?: string;
  output?: string;
  error?: string;
  filePath: string;
}

export function acquireMutationLock(directory: string, cwd: string, runId: string): () => void {
  const canonicalCwd = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
  const locksDirectory = join(directory, ".locks");
  const lockPath = join(locksDirectory, createHash("sha256").update(canonicalCwd).digest("hex"));
  const ownerPath = join(lockPath, "owner.json");
  mkdirSync(locksDirectory, { recursive: true });

  for (;;) {
    const temporaryPath = mkdtempSync(join(locksDirectory, ".pending-"));
    writeFileSync(join(temporaryPath, "owner.json"), JSON.stringify({ pid: process.pid, runId, cwd: canonicalCwd }));
    try {
      renameSync(temporaryPath, lockPath);
      break;
    } catch (error) {
      rmSync(temporaryPath, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      let pid: number | undefined;
      try {
        pid = JSON.parse(readFileSync(ownerPath, "utf8")).pid;
      } catch {}
      if (typeof pid === "number") {
        try {
          process.kill(pid, 0);
        } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code === "ESRCH") {
            throw new Error(`A stale asynchronous writer lock blocks ${canonicalCwd}; remove ${lockPath}`);
          }
          throw ownerError;
        }
      }
      throw new Error(`An asynchronous writer is already running in ${canonicalCwd}`);
    }
  }

  return () => {
    let owner: { runId?: string };
    try {
      owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (owner.runId !== runId) return;
    const releasedPath = `${lockPath}.released-${randomUUID()}`;
    try {
      renameSync(lockPath, releasedPath);
      rmSync(releasedPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}

export function startRunReport(directory: string, agent: string, task: string, cwd: string): RunReport {
  mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const id = randomUUID();
  const filePath = join(directory, `${startedAt.replaceAll(":", "-")}-${id}.md`);
  const report = { id, agent, task, cwd, status: "running" as const, startedAt, filePath };
  saveRunReport(report);
  return report;
}

export function saveRunReport(report: RunReport): void {
  const lines = [
    "# Subagent report",
    "",
    `- Run: ${report.id}`,
    `- Agent: ${report.agent}`,
    `- Status: ${report.status}`,
    `- Started: ${report.startedAt}`,
    ...(report.finishedAt ? [`- Finished: ${report.finishedAt}`] : []),
    ...(report.model ? [`- Model: ${report.model}`] : []),
    `- Working directory: ${report.cwd}`,
    "",
    "## Task",
    "",
    report.task,
    "",
    ...(report.output !== undefined ? ["## Report", "", report.output, ""] : []),
    ...(report.error !== undefined ? ["## Error", "", report.error, ""] : []),
  ];
  const temporaryPath = `${report.filePath}.tmp`;
  writeFileSync(temporaryPath, `${lines.join("\n").replace(/\s+$/, "")}\n`);
  renameSync(temporaryPath, report.filePath);
}

export function finishRunReport(report: RunReport, update: Pick<RunReport, "status"> & Partial<Pick<RunReport, "model" | "output" | "error">>): void {
  Object.assign(report, update, { finishedAt: new Date().toISOString() });
  saveRunReport(report);
}
