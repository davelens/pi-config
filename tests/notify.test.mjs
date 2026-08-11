import assert from "node:assert/strict";
import notify from "../extensions/notify.ts";

const handlers = {};
const commands = {};
const entries = [{
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
}];
let pushes = 0;

process.env.NTFY_URL = "https://example.test/pi";
globalThis.fetch = async () => {
  pushes++;
  return { ok: true };
};

const pi = {
  on: (event, handler) => handlers[event] = handler,
  registerCommand: (name, command) => commands[name] = command,
  appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  exec: async () => ({ code: 0 }),
};
const ctx = {
  cwd: "/tmp/project",
  hasUI: true,
  sessionManager: { getBranch: () => entries },
  ui: { notify() {}, setStatus() {} },
};

notify(pi);
await handlers.session_start({}, ctx);
await commands.phone.handler("once", ctx);
await handlers.agent_settled({}, ctx);
await handlers.agent_settled({}, ctx);

assert.equal(pushes, 1);
assert.equal(entries.at(-1).data.mode, "off");
console.log("notify test passed");
