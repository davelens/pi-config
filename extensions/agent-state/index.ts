import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdirSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

// Pushes this interactive session's status to every reader socket in
// $XDG_RUNTIME_DIR/agent-state/ (such as dotshell's ai-agents-monitor). Each
// open connection doubles as the liveness signal: a reader drops the agent as
// soon as it closes.

const SCAN_MS = 5000;

type Status = "busy" | "idle" | "error" | "input";

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

function promptPreview(text: string): string {
  const title = normalise(text);
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function asksForInput(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.endsWith("?")
    || /^\s*(pick|choose|select|run|proceed|continue|which|want me to|should i|shall i|ok to|okay to|approve|confirm)\b.*\?\s*$/im.test(trimmed);
}

export default function (pi: ExtensionAPI) {
  const sockets = new Map<string, Socket>();
  let scan: ReturnType<typeof setInterval> | undefined;
  let cwd = "";
  let running = false;
  let prompting = false;
  let settled: Status = "idle";
  let name: string | undefined;
  let firstPrompt = "";

  function status(): Status {
    if (prompting) return "input";
    return running ? "busy" : settled;
  }

  const line = () => `${JSON.stringify({
    provider: "pi", pid: process.pid, cwd, status: status(), title: name || firstPrompt,
  })}\n`;

  function send() {
    for (const socket of sockets.values()) {
      if (!socket.connecting && !socket.destroyed) socket.write(line());
    }
  }

  // Connects to reader sockets that appeared since the last scan, so readers
  // can start (or restart) at any time.
  function connectAll() {
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
    const dir = join(runtimeDir, "agent-state");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // No reader has created the directory yet.
    }
    for (const name of names) {
      const path = join(dir, name);
      if (!name.endsWith(".sock") || sockets.has(path)) continue;
      const conn = createConnection(path);
      sockets.set(path, conn);
      conn.unref();
      conn.on("connect", () => conn.write(line()));
      // Monitoring must not interrupt Pi; a dead reader just means retrying.
      conn.on("error", () => {});
      conn.on("close", () => {
        if (sockets.get(path) === conn) sockets.delete(path);
      });
    }
  }

  function stop() {
    clearInterval(scan);
    scan = undefined;
    for (const socket of sockets.values()) socket.destroy();
    sockets.clear();
  }

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    stop();
    if (ctx.mode !== "tui") return;

    cwd = ctx.cwd;
    running = !ctx.isIdle();
    prompting = false;
    settled = "idle";
    name = normalise(ctx.sessionManager.getSessionName() ?? "") || undefined;
    const first = ctx.sessionManager.getEntries().find(
      entry => entry.type === "message" && entry.message.role === "user" && textOf(entry.message),
    );
    firstPrompt = first?.type === "message" ? promptPreview(textOf(first.message)) : "";
    connectAll();
    scan = setInterval(connectAll, SCAN_MS);
    scan.unref();
  });

  pi.on("session_shutdown", stop);

  pi.on("session_info_changed", event => {
    name = normalise(event.name ?? "") || undefined;
    send();
  });

  pi.on("message_start", event => {
    if (firstPrompt || event.message.role !== "user") return;
    firstPrompt = promptPreview(textOf(event.message));
    if (firstPrompt) send();
  });

  pi.on("agent_start", () => {
    running = true;
    send();
  });

  // agent_end is not final (retries and queued work follow), so only record
  // the outcome here and report it once the agent settles.
  pi.on("agent_end", event => {
    const reply = event.messages.findLast(message => message.role === "assistant");
    if (!reply || reply.role !== "assistant") settled = "idle";
    else if (reply.stopReason === "aborted" || reply.stopReason === "error" || reply.errorMessage) settled = "error";
    else settled = asksForInput(textOf(reply)) ? "input" : "idle";
  });

  pi.on("agent_settled", () => {
    running = false;
    send();
  });

  pi.on("ui_prompt_start", () => {
    prompting = true;
    send();
  });

  pi.on("ui_prompt_end", () => {
    prompting = false;
    send();
  });
}
