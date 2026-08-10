import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function notify(pi: ExtensionAPI) {
  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    await pi.exec("notify-send", ["-a", "Pi", "--", "Pi is ready", basename(ctx.cwd)]);
  });
}
