#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v node >/dev/null 2>&1 \
    || ! node --experimental-strip-types --input-type=module -e '' >/dev/null 2>&1; then
  echo 'skip - Pi extension lifecycle tests require Node with native TypeScript stripping (22.6+)'
  exit 0
fi
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

node --experimental-strip-types --input-type=module - "$REPO_ROOT" "$SANDBOX" <<'JS'
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, sandbox] = process.argv.slice(2);
const { default: extension } = await import(pathToFileURL(join(root,
  "extensions/dotshell-agent-state/index.ts")));
const state = join(sandbox, "state");
process.env.PI_AGENT_STATE_DIR = state;
// Linux comm may include spaces and closing parentheses, not just a plain 'pi'.
process.title = "pi ) worker";
const startTicks = readFileSync(`/proc/${process.pid}/stat`, "utf8").match(/^\d+ \(.*\) (.*)$/s)[1].trim().split(/\s+/)[19];
const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const path = join(state, `${process.pid}.json`);
const context = (mode, id, file) => ({
  mode, hasUI: mode === "tui" || mode === "rpc",
  sessionManager: { getSessionId: () => id, getSessionFile: () => file },
});
function load() {
  const handlers = {};
  extension({ on: (event, handler) => { handlers[event] = handler; } });
  assert.deepEqual(Object.keys(handlers).sort(), ["session_shutdown", "session_start"]);
  return handlers;
}
let handlers = load();
assert.equal(existsSync(state), false, "factory does no I/O");
for (const reason of ["startup", "resume", "new", "fork", "reload"]) {
  const file = join(sandbox, `${reason}.jsonl`);
  await handlers.session_start({ reason }, context("tui", reason, file));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    version: 1, pid: process.pid, startTicks, bootId, sessionId: reason, sessionFile: file,
  });
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(state), [`${process.pid}.json`], "atomic publication leaves no temporary files");
  const shutdownReason = reason === "startup" ? "quit" : reason;
  await handlers.session_shutdown({ reason: shutdownReason });
  await handlers.session_shutdown({ reason: shutdownReason });
  assert.equal(existsSync(path), false);
  handlers = load(); // Pi recreates the extension runtime on session replacement/reload.
  console.log(`ok - extension ${reason} publishes exact identity and shutdown is idempotent`);
}
await handlers.session_start({ reason: "new" }, context("tui", "ephemeral", undefined));
assert.equal(JSON.parse(readFileSync(path, "utf8")).sessionFile, null);
await handlers.session_shutdown({ reason: "quit" });
console.log("ok - nonpersistent session records null, never a previous file");

for (const mode of ["rpc", "json", "print", undefined]) {
  handlers = load();
  await handlers.session_start({ reason: "startup" }, context(mode, "headless", "/unused"));
  await handlers.session_shutdown({ reason: "quit" });
  assert.equal(existsSync(path), false);
}
console.log("ok - headless modes publish nothing, including RPC with hasUI");

handlers = load();
await handlers.session_start({ reason: "startup" }, context("tui", "owned", "/owned"));
writeFileSync(path, "unrelated replacement");
await handlers.session_shutdown({ reason: "quit" });
assert.equal(readFileSync(path, "utf8"), "unrelated replacement");
console.log("ok - shutdown leaves records it does not own untouched");

// An existing regular file is a portable filesystem failure, even when tests run as root.
const blocked = join(sandbox, "blocked");
writeFileSync(blocked, "not a directory");
process.env.PI_AGENT_STATE_DIR = blocked;
handlers = load();
await handlers.session_start({ reason: "startup" }, context("tui", "failure", "/unused"));
await handlers.session_shutdown({ reason: "quit" });
assert.equal(readFileSync(blocked, "utf8"), "not a directory");
console.log("ok - registry filesystem failure does not disrupt lifecycle handlers");

// Exercise the shared directory precedence without writing into the user's environment.
delete process.env.PI_AGENT_STATE_DIR;
process.env.XDG_RUNTIME_DIR = join(sandbox, "runtime");
process.env.XDG_CACHE_HOME = join(sandbox, "cache");
process.env.HOME = join(sandbox, "home");
for (const base of [process.env.XDG_RUNTIME_DIR, process.env.XDG_CACHE_HOME, join(process.env.HOME, ".cache")]) {
  mkdirSync(base, { recursive: true });
  handlers = load();
  await handlers.session_start({ reason: "startup" }, context("tui", "fallback", undefined));
  const file = join(base, "dotshell-agent-state", `${process.pid}.json`);
  assert.equal(existsSync(file), true);
  await handlers.session_shutdown({ reason: "quit" });
  assert.equal(existsSync(file), false);
  if (process.env.XDG_RUNTIME_DIR) delete process.env.XDG_RUNTIME_DIR;
  else delete process.env.XDG_CACHE_HOME;
}
console.log("ok - registry directory uses runtime, cache, then home fallback");
JS
