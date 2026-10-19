import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHash, continuationPrompt, transcriptHash, validateContinuation } from "./continuation.ts";
import { acquireSessionLock, type RunReport } from "./reports.ts";
import type { AgentConfig } from "./agents.ts";

function fixture() {
  const root = mkdtempSync(join(import.meta.dirname, ".continuation-test-"));
  const sessions = join(root, "sessions");
  mkdirSync(sessions);
  const path = join(sessions, "child.jsonl");
  const agent: AgentConfig = { name: "test", tools: ["read"], prompt: "Read only", filePath: "test.md" };
  const entries = [
    { type: "session", version: 3, id: "child", cwd: root },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "Original assignment" } },
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [], stopReason: "aborted" } },
  ];
  writeFileSync(path, entries.map(JSON.stringify).join("\n"));
  const report: RunReport = {
    id: "run", agent: "test", task: "Original assignment", cwd: root, status: "aborted", startedAt: "now", filePath: join(root, "report.md"), sessionPaths: [path],
    checkpoint: { sessionPath: path, sessionId: "child", leafId: "a", configHash: configHash(agent), transcriptHash: transcriptHash(path), model: "fake/model", thinking: "off" },
  };
  return { root, sessions, path, agent, entries, report, validate: () => validateContinuation(report, agent, root, sessions) };
}

test("continuation preserves identity and refuses lost, changed or permission-expanded state", () => {
  const f = fixture();
  try {
    assert.equal(f.validate().sessionId, "child");
    assert.match(continuationPrompt(f.report.task), /Original assignment/);
    assert.match(continuationPrompt(f.report.task), /Do not blindly replay side-effecting tools/);
    f.agent.tools.push("write");
    assert.throws(f.validate, /configuration changed/);
    f.agent.tools.pop();
    f.report.status = "running";
    assert.throws(f.validate, /Only a cancelled/);
    f.report.status = "aborted";
    assert.throws(() => validateContinuation(f.report, f.agent, f.sessions, f.sessions), /original working directory/);
    const original = readFileSync(f.path, "utf8");
    writeFileSync(f.path, `${original}\n{broken`);
    assert.throws(f.validate, /changed since/);
    f.report.checkpoint!.transcriptHash = transcriptHash(f.path);
    assert.throws(f.validate, SyntaxError);
    writeFileSync(f.path, original);
    f.report.checkpoint!.transcriptHash = transcriptHash(f.path);
    f.report.checkpoint!.leafId = "wrong";
    assert.throws(f.validate, /incomplete or stale/);
    f.report.checkpoint!.leafId = "a";
    rmSync(f.path);
    assert.throws(f.validate, /ENOENT/);
    writeFileSync(join(f.root, "outside.jsonl"), original);
    symlinkSync(join(f.root, "outside.jsonl"), f.path);
    assert.throws(f.validate, /outside the managed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("child-session lock excludes concurrent continuation even for readers", () => {
  const f = fixture();
  try {
    const release = acquireSessionLock(f.root, f.path, "first");
    assert.throws(() => acquireSessionLock(f.root, f.path, "second"), /child session is already running/);
    const alias = join(f.sessions, "alias.jsonl");
    symlinkSync(f.path, alias);
    assert.throws(() => acquireSessionLock(f.root, alias, "alias"), /child session is already running/);
    release();
    acquireSessionLock(f.root, f.path, "second")();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
