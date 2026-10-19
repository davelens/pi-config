import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { StallWatchdog, SubagentStallError, watchdogClock, type WatchdogClock } from "./stall-watchdog.ts";

interface PromptSession {
  abort(): void | Promise<void>;
  prompt(prompt: string): Promise<void>;
  steer(text: string): Promise<"queued" | "handled">;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export async function promptChild(session: PromptSession, prompt: string, signal: AbortSignal, timeoutMs?: number, onWarning: (warning: string) => void = () => {}, clock: WatchdogClock = watchdogClock): Promise<void> {
  let terminal: Error | undefined;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let aborting: Promise<void> | undefined;
  const stop = (error: Error) => {
    if (terminal || settled) return;
    terminal = error;
    watchdog.dispose();
    // Observe rejection immediately, but keep the writer lock until both operations settle.
    aborting = Promise.resolve().then(() => session.abort()).catch(() => {});
  };
  const notify = (message: string) => {
    if (terminal || settled) return;
    try { onWarning(message); }
    catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
  };
  const warning = (reason: string, evidence: string) => {
    const message = `Subagent watchdog suspects ${reason}: ${evidence}. Provide concrete findings/checkpoint and change approach, or return a partial result with blockers. Persistent stalls will be stopped without automatic restart.`;
    notify(message);
    if (terminal || settled) return;
    void (async () => {
      try {
        const state = await session.steer(message);
        notify(`Watchdog steering ${state} for ${reason}${state === "queued" ? " (delivery waits for the current turn/tools)" : ""}`);
      } catch {
        notify(`Watchdog steering failed for ${reason}; recovery grace still applies`);
      }
    })();
  };
  const watchdog = new StallWatchdog({ clock, warn: warning, stop: (reason) => stop(new SubagentStallError(reason)) });
  const unsubscribe = session.subscribe((event) => { if (!terminal) watchdog.event(event); });
  const cancel = () => stop(signal.reason instanceof Error ? signal.reason : new Error("Subagent aborted"));
  signal.addEventListener("abort", cancel, { once: true });
  if (timeoutMs !== undefined) timeout = clock.setTimer(() => stop(new Error(`Subagent attempt timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    signal.throwIfAborted();
    await session.prompt(prompt);
    if (terminal) throw terminal;
  } catch (error) {
    throw terminal ?? error;
  } finally {
    settled = true;
    if (timeout !== undefined) clock.clearTimer(timeout);
    signal.removeEventListener("abort", cancel);
    unsubscribe();
    watchdog.dispose();
    if (aborting) await aborting;
  }
}
