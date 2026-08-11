import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PhoneMode = "off" | "on" | "once";

const phoneConfig = join(homedir(), ".config/ntfy/pi-url");

export default function notify(pi: ExtensionAPI) {
  let phoneMode: PhoneMode = "off";

  const setPhoneMode = (mode: PhoneMode, ctx: ExtensionContext) => {
    phoneMode = mode;
    pi.appendEntry("phone-notify", { mode });
    ctx.ui.setStatus("phone-notify", mode === "off" ? undefined : `phone:${mode}`);
  };

  pi.on("session_start", (_event, ctx) => {
    const saved = ctx.sessionManager.getBranch().findLast(
      entry => entry.type === "custom" && entry.customType === "phone-notify",
    );
    const mode = saved?.type === "custom"
      ? (saved.data as { mode?: PhoneMode })?.mode
      : undefined;
    phoneMode = mode === "on" || mode === "once" ? mode : "off";
    ctx.ui.setStatus("phone-notify", phoneMode === "off" ? undefined : `phone:${phoneMode}`);
  });

  pi.registerCommand("phone", {
    description: "Control phone notifications: on, off, or once",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (!mode) {
        ctx.ui.notify(`Phone notifications: ${phoneMode}`, "info");
        return;
      }
      if (mode !== "on" && mode !== "off" && mode !== "once") {
        ctx.ui.notify("Usage: /phone on|off|once", "error");
        return;
      }
      setPhoneMode(mode, ctx);
      ctx.ui.notify(`Phone notifications: ${mode}`, "info");
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const lastAssistant = ctx.sessionManager.getBranch().findLast(
      entry => entry.type === "message" && entry.message.role === "assistant",
    );
    const text = lastAssistant?.type === "message"
      ? lastAssistant.message.content
          .filter(part => part.type === "text")
          .map(part => part.text)
          .join("\n")
      : "";
    const requiresInput = /\?\s*$/.test(text);
    const title = requiresInput ? "Pi requires input" : "Pi is idle";
    const project = basename(ctx.cwd);

    await pi.exec("notify-send", [
      "-u", requiresInput ? "critical" : "normal",
      "-a", "Pi",
      "--", title, project,
    ]);

    if (phoneMode === "off") return;

    try {
      const endpoint = process.env.NTFY_URL?.trim() || (await readFile(phoneConfig, "utf8")).trim();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Title: title,
          Priority: requiresInput ? "high" : "default",
          Tags: requiresInput ? "question" : "white_check_mark",
        },
        body: project,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (phoneMode === "once") setPhoneMode("off", ctx);
    } catch (error) {
      ctx.ui.notify(`Phone notification failed: ${error instanceof Error ? error.message : error}`, "error");
    }
  });
}
