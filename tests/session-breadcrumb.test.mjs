import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { addSessionToPowerline } from "../extensions/session-breadcrumb/powerline-line.ts";

const visibleWidth = text => [...text].length;
const truncateToWidth = (text, width, ellipsis = "...") => {
  const characters = [...text];
  if (characters.length <= width) return text;
  if (width <= ellipsis.length) return ellipsis.slice(0, width);
  return characters.slice(0, width - ellipsis.length).join("") + ellipsis;
};

const line = "─ GPT-5.6 Sol  pi-config ────────────────────";
const session = "   Backend > Flexible Content ";
const rendered = addSessionToPowerline(line, session, visibleWidth, truncateToWidth);

assert.equal(
  rendered,
  "─ GPT-5.6 Sol  pi-config   Backend > F...──",
);
assert.equal(visibleWidth(rendered), visibleWidth(line));
assert.equal(addSessionToPowerline("plain text", session, visibleWidth, truncateToWidth), "plain text");

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const jitiUrl = pathToFileURL(join(
  globalRoot,
  "@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs",
));
const { createJiti } = await import(jitiUrl.href);
const tempDir = await mkdtemp(join(tmpdir(), "session-breadcrumb-"));
const tuiMock = join(tempDir, "pi-tui.mjs");
await writeFile(tuiMock, `
  export const visibleWidth = text => [...text].length;
  export const truncateToWidth = (text, width) => [...text].slice(0, width).join("");
`);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": tuiMock,
    "@earendil-works/pi-tui": tuiMock,
  },
});
const importedExtension = await jiti.import(
  new URL("../extensions/session-breadcrumb/index.ts", import.meta.url).pathname,
);
const sessionBreadcrumb = importedExtension.default ?? importedExtension;
const handlers = {};
let wrappedEditor;
const pi = {
  getSessionName: () => "Backend",
  on: (event, handler) => handlers[event] = handler,
};
sessionBreadcrumb(pi);

const ctx = {
  ui: {
    getEditorComponent: () => () => ({
      invalidate() {},
      render: () => ["─ model  folder ──────────"],
    }),
    setEditorComponent: factory => wrappedEditor = factory,
    theme: { fg: (_color, text) => text },
  },
};

handlers.session_start({}, ctx);
assert.doesNotThrow(() => wrappedEditor({ requestRender() {} }, {}, {}).render(40));
await rm(tempDir, { recursive: true });
console.log("session breadcrumb test passed");
