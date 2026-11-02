import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

// Pushes this interactive session's status to dotshell's ai-agents-monitor
// over its Unix socket. The open connection doubles as the liveness signal:
// dotshell drops the agent as soon as it closes.

const RETRY_MS = 5000;

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
  let socket: Socket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let active = false;
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

  function send() {
    if (!socket || socket.connecting || socket.destroyed) return;
    socket.write(`${JSON.stringify({
      provider: "pi", pid: process.pid, cwd, status: status(), title: name || firstPrompt,
    })}\n`);
  }

  function connect() {
    retry = undefined;
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
    const conn = createConnection(join(runtimeDir, "dotshell-agents.sock"));
    socket = conn;
    conn.unref();
    conn.on("connect", send);
    // Monitoring must not interrupt Pi; a missing dotshell just means retrying.
    conn.on("error", () => {});
    conn.on("close", () => {
      if (socket !== conn) return;
      socket = undefined;
      if (!active) return;
      retry = setTimeout(connect, RETRY_MS);
      retry.unref();
    });
  }

  function stop() {
    active = false;
    clearTimeout(retry);
    retry = undefined;
    socket?.destroy();
    socket = undefined;
  }

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    stop();
    if (ctx.mode !== "tui") return;

    active = true;
    cwd = ctx.cwd;
    running = !ctx.isIdle();
    prompting = false;
    settled = "idle";
    name = normalise(ctx.sessionManager.getSessionName() ?? "") || undefined;
    const first = ctx.sessionManager.getEntries().find(
      entry => entry.type === "message" && entry.message.role === "user" && textOf(entry.message),
    );
    firstPrompt = first?.type === "message" ? promptPreview(textOf(first.message)) : "";
    connect();
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
