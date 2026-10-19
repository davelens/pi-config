import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { promptChild } from "./prompt-child.ts";
import { StallWatchdog, SubagentStallError, type WatchdogClock } from "./stall-watchdog.ts";

function clock() {
  let now = 0;
  let id = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
  const setTimer: WatchdogClock["setTimer"] = (callback, delay) => {
    const key = ++id as unknown as ReturnType<typeof setTimeout>;
    timers.set(key, { at: now + delay, callback });
    return key;
  };
  const advance = (duration: number) => {
    const end = now + duration;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  };
  return { now: () => now, setTimer, clearTimer: (key: ReturnType<typeof setTimeout>) => { timers.delete(key); }, advance, pending: () => timers.size };
}

const minute = 60_000;
function fixture() {
  const time = clock();
  const warnings: string[] = [], stops: string[] = [];
  const watchdog = new StallWatchdog({ clock: time, warn: (reason) => warnings.push(reason), stop: (reason) => stops.push(reason) });
  let id = 0;
  const call = (path = "a", result: unknown = "same", newTurn = true) => {
    const toolCallId = String(++id);
    if (newTurn) watchdog.event({ type: "message_end", message: { role: "assistant", content: [] } });
    watchdog.event({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path } });
    watchdog.event({ type: "tool_execution_end", toolCallId, result });
  };
  const question = (toolCallId: string, start: boolean) => watchdog.event({
    type: start ? "tool_execution_start" : "tool_execution_end", toolCallId, toolName: "contact_parent",
  });
  return { time, watchdog, warnings, stops, call, question };
}

test("unique reads, thinking/text deltas and streaming tools stay active past an hour", () => {
  const f = fixture();
  f.watchdog.event({ type: "message_end", message: { role: "user", content: "string input" } });
  for (let i = 0; i < 120; i++) {
    f.time.advance(minute);
    if (i % 3 === 0) f.call(String(i));
    else if (i % 3 === 1) f.watchdog.event({ type: "message_update", message: { role: "assistant", content: [] } });
    else f.watchdog.event({ type: "tool_execution_update", toolCallId: "long-command" });
  }
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(f.stops, []);
  f.watchdog.dispose();
  assert.equal(f.time.pending(), 0);
});

test("silence alone never warns or stops, including a long-running tool", () => {
  const f = fixture();
  f.time.advance(24 * 60 * minute);
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(f.stops, []);
  f.watchdog.event({ type: "tool_execution_start", toolCallId: "slow", toolName: "bash", args: { command: "slow-job" } });
  f.time.advance(24 * 60 * minute);
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(f.stops, []);
  f.watchdog.dispose();
  assert.equal(f.time.pending(), 0);
});

for (const size of [1, 2, 3, 4]) {
  test(`exact ${size}-call cycles warn then stop despite reassuring assistant prose`, () => {
    const f = fixture();
    for (let i = 0; i < 80 && !f.stops.length; i++) {
      f.time.advance(minute / 2);
      f.watchdog.event({ type: "message_update", message: { role: "assistant", content: "Still making progress" } });
      f.call(String(i % size));
      if (f.warnings.length && !f.stops.length) assert.equal(f.warnings.length, 1);
    }
    assert.deepEqual(f.warnings, ["repeated tool cycle"]);
    assert.deepEqual(f.stops, ["repeated tool cycle"]);
    assert.equal(f.time.pending(), 0);
  });
}

test("changed arguments or results break loop evidence and permit later detection", () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) { f.time.advance(minute); f.call(); }
  assert.equal(f.warnings.length, 1);
  f.call("a", "different");
  for (let i = 0; i < 15; i++) { f.time.advance(minute); f.call(String(i), { text: i }); }
  assert.deepEqual(f.stops, []);
  for (let i = 0; i < 12; i++) { f.time.advance(minute); f.call(); }
  assert.equal(f.warnings.length, 2);
  f.watchdog.dispose();
});

test("fast repetition and one parallel assistant turn alone are insufficient", () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) f.call();
  assert.deepEqual(f.warnings, []);
  f.call("new");
  for (let i = 0; i < 40; i++) { f.time.advance(minute); f.call("batch", "same", false); }
  assert.deepEqual(f.warnings, []);
  f.watchdog.dispose();
});

test("parallel completion order, canonical argument keys and nested events do not defeat cycles", () => {
  const f = fixture();
  for (let i = 0; i < 30 && !f.stops.length; i++) {
    f.time.advance(minute);
    f.watchdog.event({ type: "message_end", message: { role: "assistant" } });
    for (const key of ["a", "b"]) f.watchdog.event({ type: "tool_execution_start", toolCallId: key, toolName: "read", args: i % 2 ? { offset: 1, path: key } : { path: key, offset: 1 } });
    f.watchdog.event({ type: "tool_execution_start", toolCallId: "nested", parentToolCallId: "a", toolName: "read", args: i });
    f.watchdog.event({ type: "tool_execution_end", toolCallId: "nested", parentToolCallId: "a", result: i });
    for (const key of i % 2 ? ["b", "a"] : ["a", "b"]) f.watchdog.event({ type: "tool_execution_end", toolCallId: key, result: key });
  }
  assert.deepEqual(f.warnings, ["repeated tool cycle"]);
  assert.deepEqual(f.stops, ["repeated tool cycle"]);
});

test("questionnaires freeze loop grace, including queued and overlapping calls", () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) { f.time.advance(minute); f.call(); }
  f.time.advance(4 * minute);
  f.watchdog.event({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "q1", name: "contact_parent" }] } });
  f.time.advance(60 * minute);
  f.question("q1", true);
  f.question("q2", true);
  f.time.advance(60 * minute);
  f.question("q1", false);
  f.time.advance(60 * minute);
  assert.deepEqual(f.stops, []);
  f.question("q2", false);
  f.call(); f.call();
  assert.deepEqual(f.stops, []);
  f.time.advance(minute);
  f.call();
  assert.deepEqual(f.stops, ["repeated tool cycle"]);
});

test("silence after a loop warning never escalates without more repetition", () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) { f.time.advance(minute); f.call(); }
  f.time.advance(24 * 60 * minute);
  assert.deepEqual(f.warnings, ["repeated tool cycle"]);
  assert.deepEqual(f.stops, []);
  f.call("changed approach");
  assert.deepEqual(f.stops, []);
  f.watchdog.dispose();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function promptFixture() {
  const time = clock();
  const prompt = deferred(), abort = deferred();
  const warnings: string[] = [], steering: string[] = [];
  const signal = new AbortController();
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let aborts = 0;
  const session = {
    prompt: () => prompt.promise,
    abort: () => { aborts++; prompt.resolve(); return abort.promise; },
    steer: async (text: string) => { steering.push(text); return "queued" as const; },
    subscribe: (callback: (event: AgentSessionEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
  };
  const emit = (event: Parameters<StallWatchdog["event"]>[0]) => listener?.(event as AgentSessionEvent);
  let callId = 0;
  const repeat = (count: number) => {
    for (let i = 0; i < count; i++) {
      time.advance(minute);
      const toolCallId = String(++callId);
      emit({ type: "message_end", message: { role: "assistant" } });
      emit({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "same" } });
      emit({ type: "tool_execution_end", toolCallId, result: "unchanged" });
    }
  };
  return { time, prompt, abort, warnings, steering, signal, session, emit, repeat, aborts: () => aborts, subscribed: () => Boolean(listener) };
}

test("prompt lifecycle steers before stopping, awaits abort settlement, and preserves the terminal reason", async () => {
  const f = promptFixture();
  const running = promptChild(f.session, "Task", f.signal.signal, undefined, (warning) => f.warnings.push(warning), f.time);
  const rejected = assert.rejects(running, SubagentStallError);
  let done = false;
  void running.catch(() => {}).then(() => { done = true; });
  f.repeat(12);
  await Promise.resolve();
  assert.equal(f.steering.length, 1);
  assert.match(f.warnings[0]!, /5 active minutes/);
  assert.match(f.warnings[1]!, /queued/);
  f.emit({ type: "message_end", message: { role: "user", content: f.steering[0] } });
  f.repeat(5);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.aborts(), 1);
  assert.equal(done, false, "prompt resolution cannot release a writer while abort is pending");
  f.abort.resolve();
  await rejected;
  assert.equal(f.time.pending(), 0);
  assert.equal(f.subscribed(), false);
});

test("successful partial results clean up, including late steering callbacks", async () => {
  const f = promptFixture();
  const delayed = deferred();
  f.session.steer = async () => { await delayed.promise; return "queued"; };
  const running = promptChild(f.session, "Task", f.signal.signal, undefined, (warning) => f.warnings.push(warning), f.time);
  f.repeat(12);
  f.prompt.resolve();
  await running;
  delayed.resolve();
  await Promise.resolve(); await Promise.resolve();
  f.time.advance(120 * minute);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.aborts(), 0);
  assert.equal(f.time.pending(), 0);
  assert.equal(f.subscribed(), false);
});

test("steering failures do not suppress loop termination", async () => {
  const f = promptFixture();
  f.session.steer = async () => { throw new Error("failed"); };
  const running = promptChild(f.session, "Task", f.signal.signal, undefined, (warning) => f.warnings.push(warning), f.time);
  const rejected = assert.rejects(running, SubagentStallError);
  f.repeat(12);
  await Promise.resolve();
  assert.match(f.warnings.at(-1)!, /steering failed/);
  f.repeat(5);
  f.abort.resolve();
  await rejected;
});

test("explicit deadlines and manual cancellation remain terminal even when abort resolves prompt", async () => {
  for (const manual of [false, true]) {
    const f = promptFixture();
    const running = promptChild(f.session, "Task", f.signal.signal, 15 * minute, undefined, f.time);
    const rejected = assert.rejects(running, manual ? /manual stop/ : /timed out after 900000ms/);
    if (manual) f.signal.abort(new Error("manual stop"));
    else {
      f.emit({ type: "tool_execution_start", toolCallId: "q", toolName: "contact_parent" });
      f.time.advance(15 * minute);
    }
    f.abort.resolve();
    await rejected;
    assert.equal(f.aborts(), 1);
    assert.equal(f.time.pending(), 0);
    assert.equal(f.subscribed(), false);
  }
});
