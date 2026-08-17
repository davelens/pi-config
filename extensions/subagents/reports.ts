import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type RunStatus = "running" | "waiting" | "completed" | "failed" | "aborted";

export interface RunReport {
  id: string;
  agent: string;
  task: string;
  cwd: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  model?: string;
  questions?: string[];
  output?: string;
  error?: string;
  sessionPaths: string[];
  filePath: string;
}

function mutationRoot(cwd: string): string {
  const canonicalCwd = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
  try {
    return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: canonicalCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch {
    return canonicalCwd;
  }
}

export function acquireMutationLock(directory: string, cwd: string, runId: string): () => void {
  const canonicalCwd = mutationRoot(cwd);
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
      let pid: number;
      try {
        pid = JSON.parse(readFileSync(ownerPath, "utf8")).pid;
        if (!Number.isInteger(pid)) throw new Error("invalid pid");
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`A writer lock with invalid ownership data blocks ${canonicalCwd}; inspect ${lockPath}`);
      }
      try {
        process.kill(pid, 0);
      } catch (ownerError) {
        const code = (ownerError as NodeJS.ErrnoException).code;
        if (code === "ESRCH") throw new Error(`A stale writer lock blocks ${canonicalCwd}; remove ${lockPath}`);
        if (code !== "EPERM") throw ownerError;
      }
      throw new Error(`A writer is already running in ${canonicalCwd}; lock=${lockPath}`);
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
  const report = { id, agent, task, cwd, status: "running" as const, startedAt, sessionPaths: [], filePath };
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
    ...report.sessionPaths.map((path) => `- Child session: ${path}`),
    "",
    "## Task",
    "",
    report.task,
    "",
    ...(report.questions?.length ? ["## Pending questions", "", ...report.questions.map((question, index) => `${index + 1}. ${question}`), ""] : []),
    ...(report.output !== undefined ? ["## Report", "", report.output, ""] : []),
    ...(report.error !== undefined ? ["## Error", "", report.error, ""] : []),
  ];
  const temporaryPath = `${report.filePath}.tmp`;
  writeFileSync(temporaryPath, `${lines.join("\n").replace(/\s+$/, "")}\n`);
  renameSync(temporaryPath, report.filePath);
}

export function recordRunSession(report: RunReport, sessionPath: string): void {
  if (report.sessionPaths.includes(sessionPath)) return;
  report.sessionPaths.push(sessionPath);
  saveRunReport(report);
}

export function pauseRunReport(report: RunReport, model: string, questions: string[]): void {
  Object.assign(report, { status: "waiting", model, questions });
  saveRunReport(report);
}

export function resumeRunReport(report: RunReport): void {
  report.status = "running";
  delete report.questions;
  saveRunReport(report);
}

export function finishRunReport(report: RunReport, update: Pick<RunReport, "status"> & Partial<Pick<RunReport, "model" | "output" | "error">>): void {
  delete report.questions;
  Object.assign(report, update, { finishedAt: new Date().toISOString() });
  saveRunReport(report);
  pruneRunReports(dirname(report.filePath));
}

export function pruneRunReports(directory: string, keep = 200): void {
  const completed = readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .filter((name) => !["- Status: running", "- Status: waiting"].includes(readFileSync(join(directory, name), "utf8").split(/\r?\n/, 6)[4] ?? ""));
  for (const name of completed.slice(0, Math.max(0, completed.length - keep))) unlinkSync(join(directory, name));
}
