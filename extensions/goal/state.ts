import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "skills");

/** The goal skills sit outside Pi's skill discovery to stay off the command list; this builds the message /skill:<name> <args> would. */
export const skillPrompt = (name: string, args: string) => {
  const dir = join(SKILLS_DIR, name);
  const file = join(dir, "SKILL.md");
  const block = `<skill name="${name}" location="${file}">\nReferences are relative to ${dir}.\n\n${readFileSync(file, "utf8").trim()}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
};

// Goal entries keep the extension's former name: sessions on disk carry it.
export const GOAL_ENTRY = "loop-with-goal";
export const GOAL_CONTROL_ENTRY = "loop-with-goal-control";
export const MAX_FAILURES = 10;
export const MAX_IDLE_STOPS = 3;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 60_000;

export type GoalStatus = "active" | "blocked" | "done";
export type PauseSource = "command" | "interrupt" | "child-viewer" | "questionnaire" | "guardrails";
export type ControlAction = "pause" | "resume" | "clear";

/** Branch-local goal state; one snapshot is appended per change. */
export interface GoalSnapshot {
  version: 1;
  goalId: string;
  text: string;
  status: GoalStatus;
  paused: boolean;
  pausedBy?: PauseSource;
  evidence?: string;
  blockedReason?: string;
  failures: number;
  lastError?: string;
  pendingChildOutcomes: string[];
  /** Set once a pause wrote the checkpoint; /goal resume then continues in a fresh session from it. */
  checkpoint?: string;
  updatedAt: string;
}

/** User-control ledger entry; the latest one per goal wins on every branch. */
export interface GoalControl {
  version: 1;
  goalId: string;
  action: ControlAction;
  source: PauseSource;
  at: string;
}

type EntryLike = Pick<SessionEntry, "type"> & { customType?: string; data?: unknown };

const STATUSES = new Set<string>(["active", "blocked", "done"]);
const ACTIONS = new Set<string>(["pause", "resume", "clear"]);

export function createGoal(text: string): GoalSnapshot {
  return { version: 1, goalId: randomUUID(), text, status: "active", paused: false, failures: 0, pendingChildOutcomes: [], updatedAt: new Date().toISOString() };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSnapshot(data: unknown): data is GoalSnapshot {
  return isObject(data) && data.version === 1 && typeof data.goalId === "string" && typeof data.text === "string"
    && STATUSES.has(String(data.status)) && typeof data.paused === "boolean" && typeof data.failures === "number"
    && Array.isArray(data.pendingChildOutcomes) && data.pendingChildOutcomes.every((item) => typeof item === "string");
}

function isControl(data: unknown): data is GoalControl {
  return isObject(data) && data.version === 1 && typeof data.goalId === "string" && ACTIONS.has(String(data.action));
}

/**
 * The goal on the active branch, with the user's latest pause/resume/clear applied from the whole file.
 * A malformed or missing snapshot reads as no goal, so bad state never continues work.
 */
export function reconstructGoal(branch: readonly EntryLike[], allEntries: readonly EntryLike[]): GoalSnapshot | undefined {
  let goal: GoalSnapshot | undefined;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY) continue;
    // A tombstone or malformed snapshot ends the goal on this branch.
    goal = isSnapshot(entry.data) ? { ...entry.data, pendingChildOutcomes: [...entry.data.pendingChildOutcomes] } : undefined;
  }
  if (!goal) return;
  let control: GoalControl | undefined;
  for (const entry of allEntries) {
    if (entry.type === "custom" && entry.customType === GOAL_CONTROL_ENTRY && isControl(entry.data) && entry.data.goalId === goal.goalId) control = entry.data;
  }
  if (!control) return goal;
  if (control.action === "clear") return;
  goal.paused = control.action === "pause";
  goal.pausedBy = control.action === "pause" ? control.source : undefined;
  return goal;
}

/** Transient provider failures back off and retry; everything else blocks visibly. */
export function classifyFailure(errorMessage: string | undefined): "transient" | "permanent" {
  if (!errorMessage) return "permanent";
  if (/api key|unauthori[sz]ed|authenticat|forbidden|\b40[134]\b|no model|not configured|\/login/i.test(errorMessage)) return "permanent";
  return isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage } as Parameters<typeof isRetryableAssistantError>[0]) ? "transient" : "permanent";
}

export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_CAP_MS);
}

export function validateEvidence(evidence: unknown): string {
  const text = typeof evidence === "string" ? evidence.trim() : "";
  if (text.replace(/\s+/g, " ").length < 20) throw new Error("evidence must name the concrete checks, files, or results that support this claim (at least 20 characters)");
  return text;
}

const RULES = `Judge every acceptance criterion against actual checks before deciding. Call goal_control with action "done" and the evidence only when every criterion is met. Call goal_control with action "blocked" when a permission denial, missing access, unsafe lock, or other obstacle prevents finishing; do not work around a denial. Record satisfied criteria with action "progress". Call it with action "resume" only when the user explicitly asks to resume a blocked goal. Otherwise continue only the useful unfinished work; do not repeat settled checks or polish finished work. Never continue, rerun, or retry a cancelled or failed subagent unless the user explicitly asks.`;

export function activationPrompt(goal: GoalSnapshot): string {
  return `Pinned goal (stays active until goal_control reports done or blocked, or the user runs /goal clear):\n${goal.text}\n\n${RULES}`;
}

export function continuationPrompt(goal: GoalSnapshot, lead: string, notes: string[] = []): string {
  const parts = [`[loop-with-goal] ${lead}`, `Pinned goal:\n${goal.text}`, `Latest evidence: ${goal.evidence ?? "none recorded"}`, ...notes, RULES];
  return parts.join("\n\n");
}

export function compactionReminder(goal: GoalSnapshot): string {
  return `[loop-with-goal] Context was compacted. The pinned goal is still ${goal.paused ? "paused" : goal.status}:\n${goal.text}\n\nLatest evidence: ${goal.evidence ?? "none recorded"}`;
}

/** Where a paused goal writes its state: next to its brief, or under .pi/ for a free-text goal. */
export function checkpointPath(goal: Pick<GoalSnapshot, "text">): string {
  const slug = /^docs\/briefs\/([a-z0-9][a-z0-9-]*)-goal\.md$/.exec(goal.text.split("\n")[0]!.trim())?.[1];
  return slug ? `docs/briefs/${slug}-state.md` : ".pi/goal-state.md";
}

export function checkpointPrompt(file: string): string {
  return `[loop-with-goal] The user paused the goal. Start no further work. Write the current state of this goal to ${file} with the write tool, so a fresh session can resume from that file alone: what is done (with evidence), what is half-done (files, uncommitted changes), the exact next steps, and open questions or blockers. Then end your turn with one short line. Every other tool call is blocked.`;
}

export interface GoalView {
  state: "active" | "paused" | "blocked" | "done";
  text: string;
  detail?: string;
}

export function goalView(goal: GoalSnapshot, detail?: string): GoalView {
  const state = goal.paused ? "paused" : goal.status;
  const text = goal.text.split("\n")[0]!.trim();
  if (state === "paused") return { state, text, detail: `${goal.pausedBy ?? "user"} — /goal resume` };
  if (state === "blocked") return { state, text, detail: goal.blockedReason };
  if (state === "done") return { state, text, detail: "/goal clear" };
  return { state, text, detail };
}

export function describeGoal(goal: GoalSnapshot, children: number, detail?: string): string {
  const view = goalView(goal, detail);
  return [
    `Goal: ${view.state}${view.detail ? ` (${view.detail})` : ""}`,
    goal.text,
    `Evidence: ${goal.evidence ?? "none recorded"}`,
    ...(goal.lastError ? [`Last error: ${goal.lastError} (failures: ${goal.failures})`] : []),
    ...(children ? [`Live subagents: ${children}`] : []),
    ...(goal.pendingChildOutcomes.length ? ["Pending subagent outcomes:", ...goal.pendingChildOutcomes.map((item) => `- ${item}`)] : []),
  ].join("\n");
}

/** One cancellable delayed action; cancel() also invalidates a callback already dequeued. */
export class RecoveryTimer {
  private handle: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  get pending(): boolean {
    return this.handle !== undefined;
  }

  arm(delayMs: number, action: () => void): void {
    this.cancel();
    const generation = this.generation;
    this.handle = setTimeout(() => {
      this.handle = undefined;
      if (generation === this.generation) action();
    }, delayMs);
    this.handle.unref?.();
  }

  cancel(): void {
    this.generation++;
    clearTimeout(this.handle);
    this.handle = undefined;
  }
}

// Persisted entry type; kept from before the /goal-loop rename so older sessions still restore.
export const LOOP_ENTRY = "plan-loop";
const ROADMAP = "docs/migration/roadmap.md";
const BRIEFS = "docs/briefs";
const PHASES = new Set<string>(["brief", "goal", "commit"]);

/** Plan-loop state; each phase that starts a new session carries it over as that session's first entry. */
export interface LoopSnapshot {
  version: 1;
  /** Plan file, relative to the working directory. */
  plan: string;
  phase: "brief" | "goal" | "commit";
  brief?: string;
  /** HEAD when the slice started; the slice counts as committed once HEAD moved and the tree is clean. */
  head: string;
  done: number;
  max?: number;
  /** Started with `/goal-loop afk`: every phase decides on its own instead of asking the user. */
  afk?: boolean;
}

export const AFK_NOTE = `The user is away from the keyboard for this whole loop. Do not ask them anything or wait for an answer: at every hiccup, open question or choice that would go to the user, take your own recommended option, record it with its reason (in a brief as "approved by delegation (user AFK)"), and carry on. Still report blocked for a permission or guardrail denial, missing access, or a destructive or outward-facing action the project's rules reserve for the user.`;

/** A phase's kick-off message, with the AFK instruction when the loop runs unattended. */
export const loopMessage = (loop: Pick<LoopSnapshot, "afk">, text: string) => loop.afk ? `${text}\n\n${AFK_NOTE}` : text;

function isLoop(data: unknown): data is LoopSnapshot {
  return isObject(data) && data.version === 1 && typeof data.plan === "string" && PHASES.has(String(data.phase))
    && typeof data.head === "string" && typeof data.done === "number" && (data.phase === "brief" || typeof data.brief === "string");
}

/** The loop on this branch; a tombstone or malformed entry ends it, so bad state never opens sessions. */
export function reconstructLoop(branch: readonly EntryLike[]): LoopSnapshot | undefined {
  let loop: LoopSnapshot | undefined;
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === LOOP_ENTRY) loop = isLoop(entry.data) ? entry.data : undefined;
  }
  return loop;
}

export function parseLoopArgs(text: string): { plan?: string; max?: number; afk?: boolean } | { error: string } {
  const words = text.split(/\s+/).filter(Boolean);
  const afk = words[0] === "afk";
  if (afk) words.shift();
  const at = words.indexOf("--max");
  let max: number | undefined;
  if (at >= 0) {
    max = Number(words[at + 1]);
    if (!Number.isInteger(max) || max < 1) return { error: "--max needs a whole number of slices, 1 or more" };
    words.splice(at, 2);
  }
  if (words.length > 1 || words[0]?.startsWith("-")) return { error: "Usage: /goal-loop [afk] [plan] [--max N] | step | stop | status" };
  return { plan: words[0], max, ...(afk && { afk }) };
}

/** A plan is open until its `Next:` line reads none; a plan without the line (older projects) stays open. */
export function planOpen(text: string): boolean {
  return !/^Next:\s*none\b/im.test(text);
}

export function briefUnstarted(text: string): boolean {
  return /^## Outcome\s*\n\s*Not started\b/m.test(text);
}

const read = (cwd: string, file: string) => readFileSync(join(cwd, file), "utf8");
const list = (cwd: string, suffix: string) => existsSync(join(cwd, BRIEFS))
  ? readdirSync(join(cwd, BRIEFS)).filter((name) => name.endsWith(suffix)).sort().map((name) => `${BRIEFS}/${name}`)
  : [];

/** Plan files, or the ones `plan` names by path, file name or slug (`roadmap`, `multi-currency`). */
export function planFiles(cwd: string, plan?: string): string[] {
  const all = [...(existsSync(join(cwd, ROADMAP)) ? [ROADMAP] : []), ...list(cwd, "-plan.md")];
  return plan ? all.filter((file) => file === plan || basename(file, ".md") === plan || basename(file, "-plan.md") === plan) : all;
}

export function openPlans(cwd: string, plan?: string): string[] {
  return planFiles(cwd, plan).filter((file) => planOpen(read(cwd, file)));
}

/** Briefs no goal has run yet: after next-slice settles, exactly one is the slice to run. */
export function unstartedBriefs(cwd: string): string[] {
  return list(cwd, "-goal.md").filter((file) => briefUnstarted(read(cwd, file)));
}

/** Why `file` cannot be pinned as an approved brief, or undefined when it can: an existing `docs/briefs/*-goal.md` that reads `Not started.` */
export function briefRefusal(cwd: string, file: string): string | undefined {
  if (!new RegExp(`^${BRIEFS}/[a-z0-9][a-z0-9-]*-goal\\.md$`).test(file)) return `'${file}' is not a ${BRIEFS}/<slug>-goal.md path`;
  if (!existsSync(join(cwd, file))) return `${file} does not exist`;
  return briefUnstarted(read(cwd, file)) ? undefined : `${file} does not read 'Not started.' under ## Outcome`;
}

export function describeLoop(loop: LoopSnapshot): string {
  return `${loop.afk ? "afk · " : ""}${loop.phase} · slice ${loop.done + 1}${loop.max ? `/${loop.max}` : ""} · ${loop.brief ?? loop.plan}`;
}
