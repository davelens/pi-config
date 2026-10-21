import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Bus channel for child run transitions; payloads are `SubagentLifecycleEvent`. */
export const SUBAGENT_LIFECYCLE_EVENT = "subagents:lifecycle";
/** Bus channel for a synchronous live-run snapshot; the emitter passes a `SubagentLiveRunsRequest` that listeners fill in. */
export const SUBAGENT_LIVE_RUNS_EVENT = "subagents:live-runs";

export type SubagentCancelSource = "viewer" | "questionnaire";
export type SubagentTerminalStatus = "completed" | "failed" | "aborted";

export interface SubagentRunIdentity {
  parentSessionId: string;
  runId: string;
  agent: string;
  task: string;
  reportPath: string;
  /** True for async runs; the parent is not blocked on them. */
  detached: boolean;
}

export type SubagentLifecycleEvent =
  | (SubagentRunIdentity & { phase: "started" | "waiting" | "running" })
  | (SubagentRunIdentity & { phase: "cancelled"; source: SubagentCancelSource })
  | (SubagentRunIdentity & { phase: "finished"; status: SubagentTerminalStatus; reason?: string;
    /** A listener sets this synchronously to own the parent wake-up; the runner then skips its own `triggerTurn` message. */
    claimed: boolean });

export interface SubagentLiveRunsRequest {
  runs: Array<SubagentRunIdentity & { status: "running" | "waiting" }>;
}

export function emitLifecycle<T extends SubagentLifecycleEvent>(pi: Pick<ExtensionAPI, "events">, event: T): T {
  pi.events.emit(SUBAGENT_LIFECYCLE_EVENT, event);
  return event;
}

export function isLifecycleEvent(data: unknown): data is SubagentLifecycleEvent {
  return typeof data === "object" && data !== null && typeof (data as SubagentLifecycleEvent).runId === "string" && typeof (data as SubagentLifecycleEvent).phase === "string";
}

export function requestLiveRuns(pi: Pick<ExtensionAPI, "events">): SubagentLiveRunsRequest["runs"] {
  const request: SubagentLiveRunsRequest = { runs: [] };
  pi.events.emit(SUBAGENT_LIVE_RUNS_EVENT, request);
  return request.runs;
}
