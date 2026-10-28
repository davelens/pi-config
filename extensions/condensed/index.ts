import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import { collapseLeadingBlanks, condenseStep } from "./format.ts";

const WIDGET = "condensed-status";
const THINKING = "Processing (thinking)";
const TOOLS = "Processing (running tools)";

export default function condensed(pi: ExtensionAPI) {
  let enabled = true;
  let status: string | undefined;
  let loader: Loader | undefined;
  let restore: (() => void) | undefined;
  const running = new Set<string>();
  const stamps = new Map<string, number>();

  const remember = (message: AgentMessage) => {
    if (message.role !== "assistant") return;
    for (const part of message.content) {
      if (part.type === "text") stamps.set(part.text.trim(), message.timestamp);
    }
  };

  // Pi has no hook to drop whole transcript rows, so tool rows and the blank
  // lines hidden thinking leaves behind are dropped at render time.
  const patch = () => {
    const tool = ToolExecutionComponent.prototype;
    const assistant = AssistantMessageComponent.prototype;
    const renderTool = tool.render;
    const renderAssistant = assistant.render;
    tool.render = function (width) {
      return enabled ? [] : renderTool.call(this, width);
    };
    assistant.render = function (width) {
      const lines = renderAssistant.call(this, width);
      return enabled ? collapseLeadingBlanks(lines) : lines;
    };
    restore = () => {
      tool.render = renderTool;
      assistant.render = renderAssistant;
    };
  };

  const show = (ctx: ExtensionContext, next: string | undefined) => {
    if (ctx.mode !== "tui" || next === status || (next && !enabled)) return;
    const shown = status !== undefined;
    status = next;
    if (!next) {
      loader = undefined;
      ctx.ui.setWidget(WIDGET, undefined);
    } else if (shown && loader) {
      loader.setMessage(next);
    } else {
      ctx.ui.setWidget(WIDGET, (tui, theme) => {
        const spinner = new Loader(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), next);
        loader = spinner;
        return Object.assign(spinner, { dispose: () => spinner.stop() });
      });
    }
  };

  const apply = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingVisible(!enabled);
    // Also rebuilds assistant messages, so the markdown transformer reruns.
    ctx.ui.setHiddenThinkingLabel(enabled ? "" : undefined);
    show(ctx, enabled && !ctx.isIdle() ? (running.size ? TOOLS : THINKING) : undefined);
  };

  pi.registerMarkdownTransformer((markdown, context) => {
    if (!enabled || context.messageType === "user") return markdown;
    if (context.messageType === "assistant-thinking") return "";
    const time = new Date(stamps.get(markdown) ?? Date.now());
    return condenseStep(markdown, time, !context.isStreaming);
  });

  pi.on("session_start", (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const saved = branch.findLast(entry => entry.type === "custom" && entry.customType === "condensed");
    enabled = saved?.type === "custom" ? (saved.data as { enabled?: boolean })?.enabled !== false : true;
    for (const entry of branch) if (entry.type === "message") remember(entry.message);
    if (ctx.mode === "tui" && !restore) patch();
    apply(ctx);
  });

  pi.on("session_shutdown", () => {
    restore?.();
    restore = undefined;
    loader?.stop();
  });

  pi.on("message_end", event => remember(event.message));

  pi.on("agent_start", (_event, ctx) => {
    running.clear();
    show(ctx, THINKING);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    running.add(event.toolCallId);
    show(ctx, TOOLS);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    running.delete(event.toolCallId);
    if (!running.size) show(ctx, THINKING);
  });

  pi.on("agent_settled", (_event, ctx) => {
    running.clear();
    show(ctx, undefined);
  });

  pi.registerCommand("condensed", {
    description: "Show only agent updates and one progress line: on, off, or toggle",
    getArgumentCompletions: prefix =>
      ["on", "off"].filter(mode => mode.startsWith(prefix.trim())).map(mode => ({ value: mode, label: mode })),
    handler: async (args, ctx) => {
      const mode = args.trim() || (enabled ? "off" : "on");
      if (mode !== "on" && mode !== "off") {
        ctx.ui.notify("Usage: /condensed [on|off]", "error");
        return;
      }
      enabled = mode === "on";
      pi.appendEntry("condensed", { enabled });
      apply(ctx);
      ctx.ui.notify(`Condensed view: ${mode}`, "info");
    },
  });
}
