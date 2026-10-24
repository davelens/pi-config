import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isLifecycleEvent, requestLiveRuns, SUBAGENT_LIFECYCLE_EVENT } from "../subagents/lifecycle.ts";
import {
  activationPrompt, backoffMs, classifyFailure, compactionReminder, continuationPrompt, createGoal, describeGoal, GOAL_CONTROL_ENTRY, GOAL_ENTRY,
  goalView, MAX_FAILURES, MAX_IDLE_STOPS, RecoveryTimer, reconstructGoal, validateEvidence, type GoalSnapshot, type GoalView, type PauseSource,
} from "./state.ts";

const WIDGET_KEY = "loop-with-goal";
const REOPEN_DELAY_MS = 3_000;
const CHILD_WAKE_DELAY_MS = 1_000;
const DISPATCH_GRACE_MS = 15_000;
const GUARDRAILS_BLOCKED_EVENT = "guardrails:action:blocked";
const controlSchema = Type.Object({
  action: StringEnum(["progress", "done", "blocked", "resume"] as const),
  evidence: Type.String({ description: "Concrete checks, files, commands, or results that support this claim" }),
});

/** One themed line that fits the editor width; wide characters are measured, not counted. */
export function goalWidgetLines(view: GoalView, theme: Pick<Theme, "fg">, width: number): string[] {
  const color = view.state === "active" ? "accent" : view.state === "paused" ? "warning" : view.state === "blocked" ? "error" : "success";
  const line = `${theme.fg("accent", "⚑")} ${theme.fg(color, view.state)} ${theme.fg("muted", "·")} ${view.text}${view.detail ? ` ${theme.fg("muted", `· ${view.detail}`)}` : ""}`;
  return [truncateToWidth(line, width)];
}

export default function loopWithGoal(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let goal: GoalSnapshot | undefined;
  const timer = new RecoveryTimer();
  const children = new Map<string, string>();
  let dialogs = 0;
  let toolsSinceStop = 0;
  let idleStops = 0;
  let lastError: string | undefined;
  let pendingRecovery: string | undefined;
  let deferredDispatch: string | undefined;
  let awaitingStart = false;
  let guardrailNote: string | undefined;
  let detail: string | undefined;
  let tui: { requestRender(): void } | undefined;
  let widgetShown = false;
  let unsubscribeInput: (() => void) | undefined;

  const active = () => goal !== undefined && goal.status === "active" && !goal.paused;
  const now = () => new Date().toISOString();
  const persist = () => { if (goal) pi.appendEntry(GOAL_ENTRY, goal); };
  const control = (action: "pause" | "resume" | "clear", source: PauseSource) => {
    if (goal) pi.appendEntry(GOAL_CONTROL_ENTRY, { version: 1, goalId: goal.goalId, action, source, at: now() });
  };
  const update = (patch: Partial<GoalSnapshot>) => {
    if (!goal) return;
    goal = { ...goal, ...patch, updatedAt: now() };
    persist();
    render();
  };

  const render = () => {
    if (!ctx || ctx.mode !== "tui") return;
    if (!goal) {
      if (widgetShown) ctx.ui.setWidget(WIDGET_KEY, undefined);
      widgetShown = false;
      return;
    }
    if (!widgetShown) {
      widgetShown = true;
      ctx.ui.setWidget(WIDGET_KEY, (widgetTui, theme) => {
        tui = widgetTui;
        return {
          render: (width: number) => goal ? goalWidgetLines(goalView(goal, detail), theme, width) : [],
          invalidate() {},
          dispose() { tui = undefined; },
        };
      }, { placement: "aboveEditor" });
    }
    tui?.requestRender();
  };

  const block = (reason: string) => {
    timer.cancel();
    pendingRecovery = undefined;
    deferredDispatch = undefined;
    detail = undefined;
    update({ status: "blocked", blockedReason: reason });
    ctx?.ui.notify(`Goal blocked: ${reason}\n/goal resume retries after you fix the cause`, "error");
  };

  // Every user cancellation lands here; it must invalidate delayed work before any await.
  const latchPause = (source: PauseSource) => {
    timer.cancel();
    pendingRecovery = undefined;
    deferredDispatch = undefined;
    awaitingStart = false;
    detail = undefined;
    if (!goal || goal.paused) return;
    update({ paused: true, pausedBy: source });
    control("pause", source);
    ctx?.ui.notify(`Goal paused (${source}); /goal resume continues it`, "warning");
  };

  const modelReady = (): string | undefined => {
    if (!ctx?.model) return "no model is selected";
    const auth = ctx.modelRegistry.getProviderAuthStatus(ctx.model.provider);
    return auth.configured ? undefined : `no authentication for provider '${ctx.model.provider}'`;
  };

  const clearToDispatch = () => Boolean(ctx && active() && ctx.isIdle() && !ctx.hasPendingMessages() && dialogs === 0 && children.size === 0);

  const notes = () => {
    const list = goal?.pendingChildOutcomes.length ? [`Subagent outcomes since you last ran (inspect their reports; do not rerun or continue them unless the user asks):\n${goal.pendingChildOutcomes.map((item) => `- ${item}`).join("\n")}`] : [];
    if (guardrailNote) list.push(`A guardrail denied an action: ${guardrailNote}. If the goal cannot be finished without it, report blocked instead of working around it.`);
    return list;
  };

  const recordFailure = (reason: string) => {
    if (!goal) return;
    const failures = goal.failures + 1;
    if (failures >= MAX_FAILURES) {
      block(`${MAX_FAILURES} consecutive recoverable failures; last: ${reason}`);
      return;
    }
    const delay = backoffMs(failures);
    detail = `retry ${failures}/${MAX_FAILURES} in ${Math.round(delay / 1000)}s`;
    update({ failures, lastError: reason });
    timer.arm(delay, () => dispatch(`The previous request failed (${reason}); recovering.`));
  };

  /** Start one parent run from idle; every gate is rechecked here because the timer may be stale. */
  const dispatch = (lead: string): boolean => {
    detail = undefined;
    if (!clearToDispatch()) {
      deferredDispatch = active() ? lead : undefined;
      render();
      return false;
    }
    deferredDispatch = undefined;
    const unavailable = modelReady();
    if (unavailable) { block(unavailable); return false; }
    const content = continuationPrompt(goal!, lead, notes());
    guardrailNote = undefined;
    if (goal!.pendingChildOutcomes.length) update({ pendingChildOutcomes: [] });
    awaitingStart = true;
    try {
      pi.sendMessage({ customType: GOAL_ENTRY, content, display: true }, { triggerTurn: true });
    } catch (error) {
      awaitingStart = false;
      recordFailure(`continuation could not be sent: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    // A run that never starts would otherwise leave the goal silently idle.
    timer.arm(DISPATCH_GRACE_MS, () => { if (awaitingStart) { awaitingStart = false; recordFailure("continuation did not start a run"); } });
    render();
    return true;
  };

  const wakeForChildren = () => {
    if (!ctx || !active() || children.size || dialogs) return;
    if (ctx.isIdle()) {
      if (!timer.pending) timer.arm(CHILD_WAKE_DELAY_MS, () => dispatch(deferredDispatch ?? "A subagent finished while you were idle."));
      return;
    }
    const content = continuationPrompt(goal!, "A subagent finished while you were working.", notes());
    update({ pendingChildOutcomes: [] });
    pi.sendMessage({ customType: GOAL_ENTRY, content, display: true }, { triggerTurn: true, deliverAs: "steer" });
  };

  const load = (c: ExtensionContext) => {
    ctx = c;
    timer.cancel();
    pendingRecovery = undefined;
    deferredDispatch = undefined;
    awaitingStart = false;
    detail = undefined;
    idleStops = 0;
    toolsSinceStop = 0;
    children.clear();
    goal = reconstructGoal(c.sessionManager.getBranch(), c.sessionManager.getEntries());
    for (const run of requestLiveRuns(pi)) if (run.parentSessionId === c.sessionManager.getSessionId()) children.set(run.runId, run.agent);
  };

  pi.on("session_start", (_event, c) => {
    load(c);
    dialogs = 0;
    widgetShown = false;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    if (c.mode === "tui") {
      // Escape during a pending native retry never reaches agent_settled as aborted; observe the key without consuming it.
      unsubscribeInput = c.ui.onTerminalInput((data) => {
        if (dialogs || !getKeybindings().matches(data, "app.interrupt")) return;
        if (!ctx?.isIdle() || timer.pending) latchPause("interrupt");
        return undefined;
      });
    }
    render();
    if (!active()) return;
    detail = `continues in ${REOPEN_DELAY_MS / 1000}s`;
    render();
    c.ui.notify(`Goal is active; continuing in ${REOPEN_DELAY_MS / 1000}s (/goal pause stops it)`, "info");
    timer.arm(REOPEN_DELAY_MS, () => dispatch("This session was reopened; the goal is still active."));
  });

  pi.on("session_tree", (_event, c) => {
    load(c);
    render();
    if (goal) c.ui.notify(`Goal on this branch is ${goalView(goal).state}; /goal resume continues it`, "info");
  });

  pi.on("session_shutdown", () => {
    timer.cancel();
    pendingRecovery = undefined;
    deferredDispatch = undefined;
    awaitingStart = false;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    tui = undefined;
    widgetShown = false;
    children.clear();
    ctx = undefined;
  });

  pi.on("ui_prompt_start", () => { dialogs++; });
  pi.on("ui_prompt_end", () => {
    dialogs = Math.max(0, dialogs - 1);
    // Let the dialog's result (including cancellation) settle before waking the parent.
    if (!dialogs && active() && deferredDispatch && !timer.pending) {
      const lead = deferredDispatch;
      timer.arm(CHILD_WAKE_DELAY_MS, () => dispatch(lead));
    }
  });

  pi.on("agent_start", () => {
    timer.cancel();
    awaitingStart = false;
    deferredDispatch = undefined;
    detail = undefined;
    lastError = undefined;
    render();
  });

  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "goal_control") toolsSinceStop++;
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") lastError = event.message.stopReason === "error" ? (event.message.errorMessage ?? "unknown provider error") : undefined;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "ask_user_question") return;
    const details = event.details as { cancelled?: boolean; error?: string } | undefined;
    if (details?.cancelled && !details.error) latchPause("questionnaire");
  });

  pi.events.on(GUARDRAILS_BLOCKED_EVENT, (data) => {
    const payload = data as { reason?: string; block?: { source?: string } };
    if (payload.block?.source === "user" || payload.block?.source === "user-stop") latchPause("guardrails");
    else if (goal) guardrailNote = payload.reason ?? "action blocked";
  });

  pi.events.on(SUBAGENT_LIFECYCLE_EVENT, (data) => {
    if (!isLifecycleEvent(data) || !ctx || data.parentSessionId !== ctx.sessionManager.getSessionId()) return;
    if (data.phase === "started" || data.phase === "waiting" || data.phase === "running") {
      children.set(data.runId, data.agent);
      return;
    }
    if (data.phase === "cancelled") {
      latchPause(data.source === "viewer" ? "child-viewer" : "questionnaire");
      return;
    }
    children.delete(data.runId);
    if (!goal || !data.detached) return;
    // The goal owns the parent's next step, so the runner's own wake-up message stays quiet.
    data.claimed = true;
    update({ pendingChildOutcomes: [...goal.pendingChildOutcomes, `${data.agent} (${data.runId}) ${data.status}${data.reason ? `: ${data.reason}` : ""}; report: ${data.reportPath}`] });
    if (active()) wakeForChildren();
  });

  pi.on("agent_before_settle", (event) => {
    if (goal?.failures && event.outcome === "completed") update({ failures: 0, lastError: undefined });
    if (!active() || event.outcome === "aborted") return;
    if (event.outcome === "error") {
      const reason = lastError ?? "unknown provider error";
      if (classifyFailure(reason) === "permanent") block(`provider error: ${reason}`);
      else pendingRecovery = reason;
      return;
    }
    if (children.size || dialogs || event.context.pendingMessages.length) {
      if (dialogs) deferredDispatch = "Continue the unfinished goal after the open dialog settles.";
      return;
    }
    if (toolsSinceStop === 0 && ++idleStops >= MAX_IDLE_STOPS) {
      block(`${MAX_IDLE_STOPS} consecutive stops without tool activity or goal_control evidence`);
      return;
    }
    if (toolsSinceStop > 0) idleStops = 0;
    toolsSinceStop = 0;
    const content = continuationPrompt(goal!, "You stopped, but the goal has not been reported done or blocked.", notes());
    guardrailNote = undefined;
    if (goal!.pendingChildOutcomes.length) update({ pendingChildOutcomes: [] });
    return { entries: [...event.entries, { type: "custom_message", customType: GOAL_ENTRY, content, display: true }], continue: true };
  });

  pi.on("agent_settled", (event) => {
    if (event.aborted) { latchPause("interrupt"); return; }
    if (!active()) return;
    if (!pendingRecovery) {
      if (deferredDispatch && !timer.pending) {
        const lead = deferredDispatch;
        timer.arm(CHILD_WAKE_DELAY_MS, () => dispatch(lead));
      }
      return;
    }
    const reason = pendingRecovery;
    pendingRecovery = undefined;
    recordFailure(reason);
  });

  pi.on("session_compact", () => {
    if (goal) pi.sendMessage({ customType: GOAL_ENTRY, content: compactionReminder(goal), display: false }, { triggerTurn: false });
  });

  pi.registerTool({
    name: "goal_control",
    label: "Goal control",
    description: "Report progress on, completion of, or a blocker for the pinned /goal, or resume a blocked goal when the user asks. Evidence must name concrete checks or results; for resume, what fixed the cause.",
    promptSnippet: "Report evidence-based progress, done, or blocked for the pinned goal, or resume it when the user asks",
    parameters: controlSchema,
    async execute(_id, params) {
      if (!goal) throw new Error("No goal is pinned; the user starts one with /goal <text>");
      const evidence = validateEvidence(params.evidence);
      idleStops = 0;
      if (params.action === "progress") update({ evidence });
      else if (params.action === "done") update({ status: "done", evidence, blockedReason: undefined });
      else if (params.action === "blocked") update({ status: "blocked", blockedReason: evidence, evidence });
      else if (goal.status === "done") throw new Error("Goal is done; the user can /goal clear it or pin a new one");
      // Resume lifts only the blocked status; a user pause stays the user's to lift.
      else update({ status: "active", blockedReason: undefined, failures: 0, lastError: undefined });
      if (params.action === "done" || params.action === "blocked") { timer.cancel(); pendingRecovery = undefined; deferredDispatch = undefined; }
      const note = goal.paused ? " The goal stays paused until the user runs /goal resume." : "";
      const label = params.action === "progress" ? "progress recorded" : params.action === "resume" ? "resumed" : params.action;
      return { content: [{ type: "text", text: `Goal ${label}.${note}` }], details: { action: params.action, status: goal.status, paused: goal.paused } };
    },
  });

  pi.registerCommand("goal", {
    description: "Pin a goal that continues until done or blocked: /goal <text> | pause | resume | status | clear",
    handler: async (args: string, c: ExtensionCommandContext) => {
      const text = args.trim();
      if (!text || text === "status") {
        c.ui.notify(goal ? describeGoal(goal, children.size, detail) : "No goal is pinned. Usage: /goal <text> | pause | resume | status | clear", "info");
        return;
      }
      if (text === "pause") {
        if (!goal) { c.ui.notify("No goal is pinned", "warning"); return; }
        if (goal.paused) { c.ui.notify("Goal is already paused", "info"); return; }
        latchPause("command");
        return;
      }
      if (text === "resume") {
        if (!goal) { c.ui.notify("No goal is pinned", "warning"); return; }
        if (goal.status === "done") { c.ui.notify("Goal is done; /goal clear it or pin a new one", "info"); return; }
        update({ paused: false, pausedBy: undefined, status: "active", blockedReason: undefined, failures: 0, lastError: undefined });
        control("resume", "command");
        idleStops = 0;
        c.ui.notify("Goal resumed (cancelled or failed subagents are not retried unless you ask)", "info");
        if (c.isIdle()) dispatch("The user resumed the goal.");
        return;
      }
      if (text === "clear") {
        if (!goal) { c.ui.notify("No goal is pinned", "info"); return; }
        timer.cancel();
        pendingRecovery = undefined;
        deferredDispatch = undefined;
        control("clear", "command");
        pi.appendEntry(GOAL_ENTRY, { version: 1, goalId: goal.goalId, cleared: true });
        goal = undefined;
        detail = undefined;
        render();
        c.ui.notify("Goal cleared", "info");
        return;
      }
      if (goal && goal.status !== "done") { c.ui.notify(`A goal is already pinned (${goalView(goal).state}); /goal clear it first`, "error"); return; }
      const unavailable = modelReady();
      if (unavailable) { c.ui.notify(`Cannot pin a goal: ${unavailable}`, "error"); return; }
      goal = createGoal(text);
      persist();
      render();
      pi.sendUserMessage(activationPrompt(goal), c.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });
}
