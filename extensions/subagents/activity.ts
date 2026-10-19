import type { MessageEvent } from "./run-stream.ts";

export const QUIET_MS = 5 * 60_000;

export interface RunActivity {
  lastActivityAt: number;
  waitingSince?: number;
  questions: Set<string>;
  tools: Map<string, { name: string; args: string }>;
}

export function newActivity(now = Date.now()): RunActivity {
  return { lastActivityAt: now, questions: new Set(), tools: new Map() };
}

export function quietFor(activity: RunActivity | undefined, now = Date.now()): number {
  return !activity || activity.waitingSince !== undefined ? 0 : Math.max(0, now - activity.lastActivityAt);
}

// Display only ordinary content, not transport fields, image payloads or opaque signatures.
export function displayValue(value: unknown, limit = 2000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, (key, item) =>
    /^(authorization|headers|cookie|password|secret|token|api[_-]?key|.*signature|data)$/i.test(key) ? "[omitted]" : item, 2) ?? "";
  return text.length > limit ? `${text.slice(0, limit)}\n[excerpt truncated]` : text;
}

export function requestExcerpt(messages: readonly unknown[]): string {
  const visible = messages.filter((item) => (item as { role?: string })?.role !== "system").slice(-4);
  const text = displayValue(visible.map((item) => {
    const message = item as { role?: string; content?: unknown; toolName?: string };
    const content = Array.isArray(message.content) ? message.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "toolCall") return { type: "toolCall", name: part.name, arguments: part.arguments };
      return { type: part.type, content: "[omitted]" };
    }) : message.content;
    return { role: message.role, toolName: message.toolName, content };
  }), Infinity);
  return text.length > 16_000 ? `[earlier context omitted]\n${text.slice(-16_000)}` : text;
}

export function observeActivity(activity: RunActivity, event: MessageEvent, now = Date.now()): void {
  if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "toolCall" && part.name === "contact_parent") activity.questions.add(part.id);
      }
    }
  }
  if (event.type === "tool_execution_start" && event.toolCallId) {
    if (event.toolName === "contact_parent") activity.questions.add(event.toolCallId);
    activity.tools.set(event.toolCallId, { name: event.toolName ?? "tool", args: displayValue(event.args) });
  }
  if (activity.questions.size && activity.waitingSince === undefined) activity.waitingSince = now;
  if (event.type === "tool_execution_end" && event.toolCallId) {
    activity.tools.delete(event.toolCallId);
    if (activity.questions.delete(event.toolCallId)) {
      if (!activity.questions.size && activity.waitingSince !== undefined) {
        activity.lastActivityAt += now - activity.waitingSince;
        activity.waitingSince = undefined;
      }
      return;
    }
  }
  if (activity.waitingSince !== undefined) return;
  const role = (event.message as { role?: string } | undefined)?.role;
  if (event.type.startsWith("tool_execution_") || ((event.type === "message_update" || event.type === "message_end") && role === "assistant")) {
    activity.lastActivityAt = now;
  }
}
