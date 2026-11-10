import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/agent-state/index.ts";

const sandbox = mkdtempSync(join(tmpdir(), "agent-state-"));
process.env.XDG_RUNTIME_DIR = sandbox;
const readerDir = join(sandbox, "agent-state");
mkdirSync(readerDir);

// Stand in for a reader's socket: collect each connection's JSON lines.
async function reader(name) {
  const connections = [];
  const server = createServer(socket => {
    const conn = { lines: [], closed: false };
    connections.push(conn);
    let buffer = "";
    socket.on("data", data => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        conn.lines.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    socket.on("close", () => { conn.closed = true; });
  });
  await new Promise(resolve => server.listen(join(readerDir, name), resolve));
  return { server, connections };
}

const { server, connections } = await reader("first.sock");
const second = await reader("second.sock");
// A reader that died without removing its socket, and an unrelated file.
writeFileSync(join(readerDir, "stale.sock"), "");
writeFileSync(join(readerDir, "notes.txt"), "");

const tick = () => new Promise(resolve => setTimeout(resolve, 50));
const last = () => connections.at(-1).lines.at(-1);

function load() {
  const handlers = {};
  extension({ on: (event, handler) => { handlers[event] = handler; } });
  return handlers;
}

const context = (mode, { name, entries = [], idle = true } = {}) => ({
  mode,
  cwd: "/work/project",
  isIdle: () => idle,
  sessionManager: { getSessionName: () => name, getEntries: () => entries },
});

const assistant = (text, extra = {}) => ({
  role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra,
});

let handlers = load();
await tick();
assert.equal(connections.length, 0, "factory opens no connection");

await handlers.session_start({ reason: "startup" }, context("tui", {
  entries: [{ type: "message", message: { role: "user", content: "  first\n  prompt " } }],
}));
await tick();
assert.deepEqual(last(), {
  provider: "pi", pid: process.pid, cwd: "/work/project", status: "idle", title: "first prompt",
});
console.log("ok - session start announces idle with the first prompt as title");

await handlers.agent_start({ type: "agent_start" });
await tick();
assert.equal(last().status, "busy");
await handlers.ui_prompt_start({ type: "ui_prompt_start", kind: "select" });
await tick();
assert.equal(last().status, "input");
await handlers.ui_prompt_end({ type: "ui_prompt_end", kind: "select" });
await tick();
assert.equal(last().status, "busy");
console.log("ok - runs are busy and blocking UI prompts are input");

await handlers.agent_end({ messages: [assistant("Stopped", { stopReason: "aborted" })] });
await tick();
assert.equal(last().status, "busy", "agent_end is not final; only settling is");
await handlers.agent_settled({ aborted: true });
await tick();
assert.equal(last().status, "error");

await handlers.agent_start({ type: "agent_start" });
await handlers.agent_end({ messages: [assistant("Done.\n\nShould I commit this?\n\nDiff below.")] });
await handlers.agent_settled({ aborted: false });
await tick();
assert.equal(last().status, "input");

await handlers.agent_start({ type: "agent_start" });
await handlers.agent_end({ messages: [assistant("All done.")] });
await handlers.agent_settled({ aborted: false });
await tick();
assert.equal(last().status, "idle");
console.log("ok - settled runs report error, a pending question, or idle");

await handlers.session_info_changed({ name: "Named  session" });
await tick();
assert.equal(last().title, "Named session");
await handlers.session_info_changed({ name: undefined });
await tick();
assert.equal(last().title, "first prompt");
console.log("ok - session names override the prompt title until cleared");

assert.equal(second.connections.length, 1);
assert.deepEqual(second.connections[0].lines, connections[0].lines);
console.log("ok - every reader socket gets the same lines; stale and unrelated files are skipped");

const long = "x".repeat(100);
handlers.session_shutdown({ reason: "new" });
handlers.session_shutdown({ reason: "new" });
await tick();
assert.equal(connections.at(-1).closed, true);
handlers = load();
await handlers.session_start({ reason: "new" }, context("tui", { idle: false }));
await handlers.message_start({ message: { role: "user", content: [{ type: "text", text: long }] } });
await tick();
assert.equal(last().status, "busy");
assert.equal(last().title, `${"x".repeat(77)}...`);
console.log("ok - shutdown closes idempotently; new sessions title from their first prompt");

handlers.session_shutdown({ reason: "quit" });
const before = connections.length;
for (const mode of ["rpc", "json", "print", undefined]) {
  handlers = load();
  await handlers.session_start({ reason: "startup" }, context(mode));
  await handlers.agent_start({ type: "agent_start" });
  handlers.session_shutdown({ reason: "quit" });
}
await tick();
assert.equal(connections.length, before);
console.log("ok - headless modes never connect");

server.close();
second.server.close();
rmSync(sandbox, { recursive: true, force: true });
