import { randomUUID } from "node:crypto";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
  updatedAt: string;
}

export interface GoalTombstone {
  version: 1;
  goalId: string;
  cleared: true;
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

const RULES = `Judge every acceptance criterion against actual checks before deciding. Call goal_control with action "done" and the evidence only when every criterion is met. Call goal_control with action "blocked" when a permission denial, missing access, unsafe lock, or other obstacle prevents finishing; do not work around a denial. Record satisfied criteria with action "progress". Otherwise continue only the useful unfinished work; do not repeat settled checks or polish finished work. Never continue, rerun, or retry a cancelled or failed subagent unless the user explicitly asks.`;

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
    if (this.handle !== undefined) clearTimeout(this.handle);
    this.handle = undefined;
  }
}
