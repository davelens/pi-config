import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import docTriggers, { coveringDocs, frontmatterPaths, loadDocs } from "./index.ts";

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doc-triggers-"));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  Object.entries(files).forEach(([path, content]) => write(path, content));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { root, write, git };
}

function harness(root: string) {
  const handlers: Record<string, Function> = {};
  const pi = {
    on: (event: string, handler: Function) => handlers[event] = handler,
    exec: async (command: string, args: string[], options: { cwd: string }) => {
      const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1, killed: false };
    },
  };
  docTriggers(pi as never);
  const ctx = { cwd: root };
  handlers.session_start({}, ctx);
  return {
    start: () => handlers.agent_start({}, ctx),
    settle: () => handlers.agent_before_settle({ entries: [], outcome: "completed", context: { canContinue: true } }, ctx),
    tool: (toolName: string, path?: string, ids: { toolCallId?: string; parentToolCallId?: string } = {}) =>
      handlers.tool_result({ toolName, toolCallId: "call", ...ids, input: { path }, content: [{ type: "text", text: "body" }] }, ctx),
  };
}

const wiki = {
  "docs/wiki/orders.md": "# Orders\n\n`app/models/order.rb` and `lib/orders/` but not `Order::STATUSES`.\n",
  "docs/wiki/colors.md": "---\npaths:\n  - app/models/palette.rb\n---\n# Colors\n\n`app/models/color.rb`\n",
  "docs/memory/key-commands.md": "# Key commands\n",
  "docs/wiki/roadmap/2025.md": "- Moved `lib/orders/` and `app/models/order.rb`\n",
  "app/models/order.rb": "class Order; end\n",
  "app/models/color.rb": "class Color; end\n",
  "lib/orders/status.rb": "module Status; end\n",
};

test("parses frontmatter paths in block and inline form", () => {
  assert.deepEqual(frontmatterPaths("---\npaths:\n  - a/b.rb\n  - \"c/\"\n---\n"), ["a/b.rb", "c/"]);
  assert.deepEqual(frontmatterPaths("---\npaths: [a/b.rb, 'c/']\n---\n"), ["a/b.rb", "c/"]);
  assert.deepEqual(frontmatterPaths("# No frontmatter `a/b.rb`"), []);
});

test("maps files to docs: exact, closest directory, then a single sibling owner", () => {
  const { root } = repo({ ...wiki, "app/models/user.rb": "", "docs/wiki/users.md": "`app/models/user.rb`" });
  const docs = loadDocs(root);
  assert.deepEqual(docs.find((doc) => doc.path === "docs/wiki/orders.md")?.paths, ["app/models/order.rb", "lib/orders/"]);
  assert.deepEqual(coveringDocs(docs, "app/models/order.rb"), ["docs/wiki/orders.md"]);
  assert.deepEqual(coveringDocs(docs, "app/models/palette.rb"), ["docs/wiki/colors.md"]);
  assert.deepEqual(coveringDocs(docs, "lib/orders/new/deep.rb"), ["docs/wiki/orders.md"]);
  assert.deepEqual(coveringDocs(docs, "bin/setup"), ["docs/memory/key-commands.md"]);
  // app/models/ has three owners, so a new model there has no owner; lib/orders/ has one.
  assert.deepEqual(coveringDocs(docs, "app/models/thing.rb", true), []);
  assert.deepEqual(coveringDocs(docs, "app/services/thing.rb", true), []);
  assert.deepEqual(coveringDocs(loadDocs(repo(wiki).root).filter((doc) => doc.path.endsWith("orders.md")), "app/models/line.rb", true), ["docs/wiki/orders.md"]);
});

test("reminds once about stale docs and uncovered new files, ignoring the user's untouched changes", async () => {
  const { root, write, git } = repo(wiki);
  write("app/models/color.rb", "class Color; def user_edit; end; end\n");
  const run = harness(root);

  await run.start();
  write("app/models/order.rb", "class Order; def total; end; end\n");
  write("lib/orders/refund.rb", "module Refund; end\n");
  write("app/services/checkout.rb", "class Checkout; end\n");
  write("spec/checkout_spec.rb", "");
  git("add", "app/models/order.rb");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "agent work");

  const result = await run.settle();
  assert.equal(result.continue, true);
  const reminder = result.entries[0].content;
  assert.match(reminder, /`docs\/wiki\/orders.md` covers .*`app\/models\/order.rb`, `lib\/orders\/refund.rb`/);
  assert.match(reminder, /No wiki entry covers these new files: `app\/services\/checkout.rb`$/m);
  assert.doesNotMatch(reminder, /color|spec\//);

  assert.equal(await run.settle(), undefined);
});

test("stays quiet when the covering doc changed with the code", async () => {
  const { root, write } = repo(wiki);
  const run = harness(root);
  await run.start();
  write("app/models/order.rb", "class Order; def total; end; end\n");
  write("app/services/checkout.rb", "class Checkout; end\n");
  write("docs/wiki/orders.md", `${wiki["docs/wiki/orders.md"]}\n\`app/services/checkout.rb\`\n`);
  assert.equal(await run.settle(), undefined);
});

test("points to an unread wiki entry once, and not after the agent read it", async () => {
  const { root } = repo(wiki);
  const run = harness(root);
  await run.start();

  const first = await run.tool("read", join(root, "app/models/order.rb"));
  assert.match(first.content.at(-1).text, /`docs\/wiki\/orders.md` covers `app\/models\/order.rb`/);
  assert.equal(await run.tool("edit", "lib/orders/status.rb"), undefined);

  await run.tool("read", "docs/wiki/colors.md");
  assert.equal(await run.tool("read", "app/models/color.rb"), undefined);
  assert.equal(await run.tool("read", "README.md"), undefined);
});

test("moves notes from nested codemode calls to the model-issued call", async () => {
  const { root } = repo(wiki);
  const run = harness(root);
  await run.start();

  assert.equal(await run.tool("read", "app/models/order.rb", { toolCallId: "c1/1", parentToolCallId: "c1" }), undefined);
  assert.equal(await run.tool("read", "app/models/color.rb", { toolCallId: "c1/2", parentToolCallId: "c1" }), undefined);
  const parent = await run.tool("codemode", undefined, { toolCallId: "c1" });
  assert.deepEqual(parent.content.slice(1).map((item: { text: string }) => item.text.match(/`docs\/wiki\/\w+\.md`/)?.[0]), [
    "`docs/wiki/orders.md`",
    "`docs/wiki/colors.md`",
  ]);
  assert.equal(await run.tool("codemode", undefined, { toolCallId: "c2" }), undefined);
});
