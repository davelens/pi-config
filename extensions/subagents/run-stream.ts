import type { RunReport } from "./reports.ts";

export interface RunMessage {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  errorMessage?: string;
  status?: "running" | "completed" | "failed";
  timestamp?: number;
  usage?: {
    input?: number;
    output?: number;
    cost?: { total?: number };
  };
}

export interface RunUsage {
  input: number;
  output: number;
  cost: number;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function runUsage(messages: RunMessage[]): RunUsage {
  return messages.reduce((total, message) => {
    if (message.role !== "assistant" && message.role !== "toolResult") return total;
    total.input += message.usage?.input ?? 0;
    total.output += message.usage?.output ?? 0;
    total.cost += message.usage?.cost?.total ?? 0;
    return total;
  }, { input: 0, output: 0, cost: 0 });
}

export function formatRunUsage(messages: RunMessage[]): string {
  const usage = runUsage(messages);
  const cost = usage.cost.toFixed(4).replace(/0$/, "");
  return `↑${formatTokens(usage.input)} · ↓${formatTokens(usage.output)} · $${cost}`;
}

export interface MessageEvent {
  type: string;
  message?: unknown;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface ActiveRun {
  report: RunReport;
  controller: AbortController;
  signal: AbortSignal;
  promise: Promise<void>;
  messages: RunMessage[];
  detached: boolean;
}

export function trackRun(runs: Map<string, ActiveRun>, report: RunReport, parentSignal: AbortSignal | undefined, detached: boolean): ActiveRun {
  const controller = new AbortController();
  const run = {
    report,
    controller,
    signal: detached || !parentSignal ? controller.signal : AbortSignal.any([parentSignal, controller.signal]),
    promise: Promise.resolve(),
    messages: [],
    detached,
  };
  runs.set(report.id, run);
  return run;
}

export async function waitForRun(run: ActiveRun, signal?: AbortSignal): Promise<void> {
  if (!run.detached) throw new Error(`Run ${run.report.id} was not started asynchronously`);
  signal?.throwIfAborted();
  if (!signal) return run.promise;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    run.promise.then(
      () => { cleanup(); resolve(); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function resultContent(result: unknown): unknown {
  return result && typeof result === "object" && "content" in result ? (result as { content: unknown }).content : result;
}

export function captureRunMessage(messages: RunMessage[], event: MessageEvent): boolean {
  if (["message_start", "message_update", "message_end"].includes(event.type)) {
    if (!event.message || typeof event.message !== "object") return false;
    const message = event.message as RunMessage;
    const matchingTool = message.role === "toolResult"
      ? messages.findLastIndex(({ toolCallId }) => toolCallId === message.toolCallId)
      : -1;
    if (matchingTool >= 0) messages[matchingTool] = message;
    else if (event.type === "message_start" || messages.length === 0) messages.push(message);
    else messages[messages.length - 1] = message;
    return true;
  }

  if (!event.toolCallId || !["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) return false;
  const index = messages.findLastIndex(({ toolCallId }) => toolCallId === event.toolCallId);
  const message: RunMessage = {
    role: "toolExecution",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    content: event.type === "tool_execution_start"
      ? event.args
      : resultContent(event.type === "tool_execution_update" ? event.partialResult : event.result),
    isError: event.type === "tool_execution_end" ? event.isError : undefined,
    status: event.type === "tool_execution_end" ? (event.isError ? "failed" : "completed") : "running",
  };
  if (index >= 0) messages[index] = message;
  else messages.push(message);
  return true;
}

export function streamJump(data: string, pendingG: boolean): { jump?: "top" | "bottom" | 10 | -10; pendingG: boolean } {
  if (data === "g") return pendingG ? { jump: "top", pendingG: false } : { pendingG: true };
  if (data === "G") return { jump: "bottom", pendingG: false };
  if (data === "}") return { jump: 10, pendingG: false };
  if (data === "{") return { jump: -10, pendingG: false };
  return { pendingG: false };
}
