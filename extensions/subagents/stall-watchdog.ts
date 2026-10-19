import { createHash } from "node:crypto";

export type StallReason = "repeated tool cycle";

export class SubagentStallError extends Error {
  readonly reason: StallReason;
  constructor(reason: StallReason) {
    super(`Subagent stopped after persistent ${reason} stall; no automatic restart`);
    this.reason = reason;
    this.name = "SubagentStallError";
  }
}

export interface WatchdogClock {
  now(): number;
  setTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

export const watchdogClock: WatchdogClock = {
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
};

interface WatchdogEvent {
  type: string;
  message?: unknown;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  parentToolCallId?: string;
}

const LOOP_MS = 5 * 60_000;
const MAX_CYCLE = 4;
const MIN_CYCLES = 6;
const MIN_CALLS = 12;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

interface CompletedCall { key: string; at: number; turn: number }
interface Cycle {
  pattern: string[];
  count: number;
  since: number;
  warned?: { at: number; count: number };
}

export class StallWatchdog {
  private clock: WatchdogClock;
  private loop?: Cycle;
  private calls: CompletedCall[] = [];
  private turn = 0;
  private stopped = false;
  private pausedAt?: number;
  private pausedDuration = 0;
  private contactCalls = new Set<string>();
  private outstanding = new Map<string, { key: string; completed?: CompletedCall }>();

  private options: {
    warn: (reason: StallReason, evidence: string) => void;
    stop: (reason: StallReason) => void;
    clock?: WatchdogClock;
  };

  constructor(options: StallWatchdog["options"]) {
    this.options = options;
    this.clock = options.clock ?? watchdogClock;
  }

  event(event: WatchdogEvent): void {
    if (this.stopped) return;
    if (event.type === "message_end") {
      const message = event.message as { role?: string; content?: unknown } | undefined;
      if (message?.role !== "assistant") return;
      this.turn++;
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "toolCall" && part.name === "contact_parent" && part.id) this.contactCalls.add(part.id);
        }
        if (this.contactCalls.size) this.pause();
      }
    } else if (event.type === "tool_execution_start" && event.toolCallId) {
      if (event.toolName === "contact_parent") {
        this.contactCalls.add(event.toolCallId);
        this.pause();
      } else if (!event.parentToolCallId) {
        this.outstanding.set(event.toolCallId, { key: fingerprint([event.toolName, event.args]) });
      }
    } else if (event.type === "tool_execution_end" && event.toolCallId) {
      if (this.contactCalls.delete(event.toolCallId)) {
        if (!this.contactCalls.size) this.resume();
        return;
      }
      const call = this.outstanding.get(event.toolCallId);
      if (!call || event.parentToolCallId) return;
      call.completed = { key: fingerprint([call.key, event.result, Boolean(event.isError)]), at: this.time(), turn: this.turn };
      // Parallel results arrive out of order; compare complete calls in their start order.
      for (const [id, pending] of this.outstanding) {
        if (!pending.completed) break;
        this.outstanding.delete(id);
        if (this.pausedAt === undefined) this.complete(pending.completed);
      }
    }
  }

  dispose(): void {
    this.stopped = true;
    this.outstanding.clear();
    this.contactCalls.clear();
  }

  private time(): number { return (this.pausedAt ?? this.clock.now()) - this.pausedDuration; }
  private pause(): void {
    if (this.pausedAt !== undefined) return;
    this.pausedAt = this.clock.now();
  }
  private resume(): void {
    if (this.pausedAt === undefined) return;
    this.pausedDuration += this.clock.now() - this.pausedAt;
    this.pausedAt = undefined;
  }
  private complete(call: CompletedCall): void {
    this.calls.push(call);
    this.calls = this.calls.slice(-MAX_CYCLE * MIN_CYCLES);
    if (this.loop && call.key === this.loop.pattern[this.loop.count % this.loop.pattern.length]) {
      this.loop.count++;
    } else {
      this.loop = undefined;
      for (let size = 1; size <= MAX_CYCLE; size++) {
        const length = Math.max(MIN_CYCLES, Math.ceil(MIN_CALLS / size)) * size;
        if (this.calls.length < length) continue;
        const tail = this.calls.slice(-length);
        if (tail[0]!.turn === tail.at(-1)!.turn) continue;
        if (tail.every((item, index) => item.key === tail[index % size]!.key)) {
          this.loop = { pattern: tail.slice(0, size).map(({ key }) => key), count: length, since: Math.min(...tail.map(({ at }) => at)) };
          break;
        }
      }
    }
    const loop = this.loop;
    if (!loop) return;
    if (!loop.warned && this.time() - loop.since >= LOOP_MS) {
      loop.warned = { at: this.time(), count: loop.count };
      this.options.warn("repeated tool cycle", `${loop.count} identical call/result steps in a ${loop.pattern.length}-call cycle over at least 5 active minutes; 5 active minutes and two more cycles allowed to recover`);
    } else if (loop.warned && this.time() - loop.warned.at >= LOOP_MS && loop.count - loop.warned.count >= 2 * loop.pattern.length) {
      this.stop("repeated tool cycle");
    }
  }

  private stop(reason: StallReason): void {
    if (this.stopped) return;
    this.dispose();
    this.options.stop(reason);
  }
}
