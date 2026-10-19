import assert from "node:assert/strict";
import { test } from "node:test";
import { newActivity, observeActivity, quietFor, QUIET_MS, requestExcerpt } from "./activity.ts";

test("quiet means five minutes without observable output or tool activity", () => {
  const activity = newActivity(0);
  assert.equal(quietFor(activity, QUIET_MS - 1), QUIET_MS - 1);
  assert.equal(quietFor(activity, QUIET_MS), QUIET_MS);
  for (const event of [
    { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Thinking" }] } },
    { type: "message_end", message: { role: "assistant", content: "Answer" } },
    { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "file" } },
    { type: "tool_execution_update", toolCallId: "read" },
    { type: "tool_execution_end", toolCallId: "read", result: "result" },
  ]) {
    observeActivity(activity, event, QUIET_MS);
    assert.equal(quietFor(activity, QUIET_MS), 0);
  }
  observeActivity(activity, { type: "message_end", message: { role: "user", content: "watchdog steering" } }, 2 * QUIET_MS);
  assert.equal(quietFor(activity, 2 * QUIET_MS), QUIET_MS, "injected prompts are not child output");
});

test("queued and overlapping questionnaires pause quiet time and track current tools", () => {
  const activity = newActivity(0);
  observeActivity(activity, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "q1", name: "contact_parent" }] } }, QUIET_MS - 1);
  assert.equal(quietFor(activity, 20 * QUIET_MS), 0);
  observeActivity(activity, { type: "tool_execution_start", toolCallId: "q1", toolName: "contact_parent", args: {} }, 20 * QUIET_MS);
  observeActivity(activity, { type: "tool_execution_start", toolCallId: "q2", toolName: "contact_parent", args: {} }, 21 * QUIET_MS);
  observeActivity(activity, { type: "tool_execution_end", toolCallId: "q1" }, 22 * QUIET_MS);
  assert.equal(activity.tools.size, 1);
  assert.equal(quietFor(activity, 40 * QUIET_MS), 0);
  observeActivity(activity, { type: "tool_execution_end", toolCallId: "q2" }, 40 * QUIET_MS);
  assert.equal(quietFor(activity, 40 * QUIET_MS), QUIET_MS - 1);
  assert.equal(quietFor(activity, 40 * QUIET_MS + 1), QUIET_MS);
  assert.equal(activity.tools.size, 0);
});

test("request excerpt is immutable, bounded and excludes transport/opaque content", () => {
  const messages = [
    { role: "system", content: "SYSTEM_SECRET", toolsAdded: [] },
    { role: "user", content: "Original assignment" },
    { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_THINKING", thinkingSignature: "OPAQUE" }, { type: "toolCall", name: "read", arguments: { path: "file", apiKey: "SECRET_KEY" } }] },
    { role: "toolResult", content: [{ type: "image", data: "IMAGE_DATA" }, { type: "text", text: "result" }], headers: { authorization: "AUTH_SECRET" } },
  ];
  const snapshot = requestExcerpt(messages);
  messages[1].content = "CHANGED";
  assert.match(snapshot, /Original assignment/);
  assert.doesNotMatch(snapshot, /SYSTEM_SECRET|PRIVATE_THINKING|OPAQUE|SECRET_KEY|IMAGE_DATA|AUTH_SECRET|CHANGED/);
  assert.ok(requestExcerpt([{ role: "user", content: "x".repeat(100_000) }]).length < 16_100);
  assert.match(requestExcerpt([{ role: "user", content: "x".repeat(100_000) }, { role: "user", content: "LATEST_REQUEST" }]), /LATEST_REQUEST/);
});
