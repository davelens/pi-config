import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function notify(pi: ExtensionAPI) {
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

    await pi.exec("notify-send", [
      "-u", requiresInput ? "critical" : "normal",
      "-a", "Pi",
      "--", title, basename(ctx.cwd),
    ]);
  });
}
