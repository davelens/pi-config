import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export default function (pi: ExtensionAPI) {
  let owned: { path: string; json: string } | undefined;

  function removeOwned() {
    if (!owned) return;
    try {
      if (readFileSync(owned.path, "utf8") === owned.json) unlinkSync(owned.path);
    } catch {
      // Monitoring must not interrupt Pi, including repeated shutdown.
    }
    owned = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    removeOwned();
    if (ctx.mode !== "tui") return;

    let temporary: string | undefined;
    try {
      const directory = process.env.PI_AGENT_STATE_DIR || join(
        process.env.XDG_RUNTIME_DIR || process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
        "dotshell-agent-state",
      );
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
      // Field 22 follows the parenthesized comm, which can itself contain spaces and ')'.
      const startTicks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(startTicks)) return;
      const sessionFile = ctx.sessionManager.getSessionFile();
      const json = JSON.stringify({
        version: 1,
        pid: process.pid,
        startTicks,
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        sessionId: ctx.sessionManager.getSessionId(),
        // Keep the future path: Pi only flushes a new session after an assistant message.
        sessionFile: sessionFile ? resolve(sessionFile) : null,
      });
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const path = join(directory, `${process.pid}.json`);
      temporary = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(temporary, json, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      owned = { path, json };
    } catch {
      // Registry failures are best-effort; discovery never guesses a replacement.
    } finally {
      if (temporary) {
        try { unlinkSync(temporary); } catch { /* Already renamed or unavailable. */ }
      }
    }
  });

  pi.on("session_shutdown", removeOwned);
}
