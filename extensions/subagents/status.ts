import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { RunReport } from "./reports.ts";
import { streamJump, type RunMessage } from "./run-stream.ts";

export interface StatusRun {
  report: RunReport;
  messages: RunMessage[];
}

interface StatusOptions {
  tui: TUI;
  theme: Theme;
  runs: () => StatusRun[];
  done: () => void;
}

function pad(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "…");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentLines(message: RunMessage, theme: Theme): string[] {
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (!Array.isArray(content)) return content === undefined ? [] : [stringify(content)];

  const lines: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === "text") lines.push(String(part.text ?? ""));
    else if (part.type === "thinking") lines.push(theme.fg("dim", `thinking\n${String(part.thinking ?? "")}`));
    else if (part.type === "toolCall") {
      lines.push(theme.fg("accent", `→ ${String(part.name ?? "tool")}`));
      lines.push(theme.fg("dim", stringify(part.arguments ?? {})));
    } else if (part.type === "image") lines.push(theme.fg("dim", `[image: ${String(part.mimeType ?? "unknown")}]`));
    else lines.push(theme.fg("dim", stringify(part)));
  }
  return lines;
}

function streamLines(run: StatusRun, width: number, theme: Theme): string[] {
  const lines: string[] = [];
  for (const message of run.messages) {
    if (lines.length) lines.push("");
    if (message.role === "user") lines.push(theme.fg("accent", theme.bold("USER")));
    else if (message.role === "assistant") lines.push(theme.fg("success", theme.bold("ASSISTANT")));
    else if (message.role === "toolResult" || message.role === "toolExecution") {
      const color = message.isError ? "error" : message.status === "running" ? "accent" : "warning";
      const status = message.status ? ` · ${message.status}` : "";
      lines.push(theme.fg(color, theme.bold(`TOOL ${message.toolName ?? ""}${status}`.trim())));
    } else lines.push(theme.fg("muted", theme.bold((message.role ?? "MESSAGE").toUpperCase())));

    for (const line of contentLines(message, theme)) {
      const wrapped = line.split("\n").flatMap((part) => wrapTextWithAnsi(part, width));
      lines.push(...(wrapped.length ? wrapped : [""]));
    }
    if (message.errorMessage) lines.push(theme.fg("error", message.errorMessage));
  }
  if (lines.length) return lines;
  if (run.report.error) return [theme.fg("error", run.report.error)];
  return [theme.fg("dim", run.report.status === "running" ? "Waiting for the first message…" : "No messages captured")];
}

export class SubagentStatus implements Component {
  private options: StatusOptions;
  private selected: number;
  private listOffset = 0;
  private contentOffset = 0;
  private contentMaxOffset = 0;
  private focus: "sidebar" | "content";
  private followTail = true;
  private pendingG = false;

  constructor(options: StatusOptions) {
    this.options = options;
    const runs = options.runs();
    this.selected = Math.max(0, runs.length - 1);
    this.focus = runs.length === 1 ? "content" : "sidebar";
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.options.done();
    if (this.options.runs().length > 1 && data === "h") return this.setFocus("sidebar");
    if (data === "l") return this.setFocus("content");
    if (matchesKey(data, "ctrl+n")) return this.moveSelection(1);
    if (matchesKey(data, "ctrl+p")) return this.moveSelection(-1);

    if (this.focus === "sidebar") {
      if (data === "j" || matchesKey(data, "down")) return this.moveSelection(1);
      if (data === "k" || matchesKey(data, "up")) return this.moveSelection(-1);
    } else {
      const navigation = streamJump(data, this.pendingG);
      this.pendingG = navigation.pendingG;
      if (navigation.jump === "top") return this.scrollTo(0);
      if (navigation.jump === "bottom") return this.scrollTo(this.contentMaxOffset, true);
      if (typeof navigation.jump === "number") return this.scrollContent(navigation.jump);
      if (data === "g") return;
      if (data === "j" || matchesKey(data, "down")) return this.scrollContent(1);
      if (data === "k" || matchesKey(data, "up")) return this.scrollContent(-1);
      if (matchesKey(data, "pageDown")) return this.scrollContent(10);
      if (matchesKey(data, "pageUp")) return this.scrollContent(-10);
      if (matchesKey(data, "home")) return this.scrollTo(0);
      if (matchesKey(data, "end")) return this.scrollTo(this.contentMaxOffset, true);
    }
  }

  render(width: number): string[] {
    const rows = this.options.tui.terminal.rows;
    const panelWidth = Math.min(width, Math.max(5, Math.floor(width * 0.7)));
    const panelHeight = Math.min(rows, Math.max(8, Math.floor(rows * 0.7)));
    const panel = this.renderPanel(panelWidth, panelHeight);
    const top = Math.max(0, Math.floor((rows - panel.length) / 2));
    const left = Math.max(0, Math.floor((width - panelWidth) / 2));
    const backdrop = this.options.theme.bg("userMessageBg", " ".repeat(width));
    const lines = Array.from({ length: rows }, () => backdrop);

    for (let index = 0; index < panel.length && top + index < lines.length; index++) {
      const panelLine = truncateToWidth(panel[index] ?? "", panelWidth, "");
      const paddedPanel = panelLine + " ".repeat(Math.max(0, panelWidth - visibleWidth(panelLine)));
      lines[top + index] = this.options.theme.bg("userMessageBg", " ".repeat(left))
        + paddedPanel
        + this.options.theme.bg("userMessageBg", " ".repeat(Math.max(0, width - left - panelWidth)));
    }
    return lines;
  }

  private renderPanel(width: number, height: number): string[] {
    const runs = this.options.runs();
    this.selected = Math.min(this.selected, Math.max(0, runs.length - 1));
    const innerWidth = Math.max(3, width - 2);
    const hasSidebar = runs.length > 1;
    const sidebarWidth = hasSidebar ? Math.max(1, Math.min(Math.floor(innerWidth * 0.3), innerWidth - 2)) : 0;
    const contentWidth = innerWidth - sidebarWidth - (hasSidebar ? 1 : 0);
    const bodyHeight = Math.max(1, height - 6);
    const border = (text: string) => this.options.theme.fg("border", text);
    const activeBorder = (section: "sidebar" | "content", text: string) =>
      this.options.theme.fg(this.focus === section ? "accent" : "border", text);
    const run = runs[this.selected];
    const content = run ? streamLines(run, contentWidth, this.options.theme) : ["No run selected"];
    this.contentMaxOffset = Math.max(0, content.length - bodyHeight);
    if (this.followTail) this.contentOffset = this.contentMaxOffset;
    else this.contentOffset = Math.min(this.contentOffset, this.contentMaxOffset);
    this.keepSelectionVisible(bodyHeight);

    const title = run ? `${run.report.agent} · ${run.report.status} · ${run.report.id.slice(0, 8)}` : "No run";
    const lines = hasSidebar
      ? [
          border("╭") + activeBorder("sidebar", "─".repeat(sidebarWidth)) + border("┬") + activeBorder("content", "─".repeat(contentWidth)) + border("╮"),
          border("│") + pad(`${this.focus === "sidebar" ? "▶ " : "  "}Runs`, sidebarWidth) + border("│") + pad(`${this.focus === "content" ? "▶ " : "  "}${title}`, contentWidth) + border("│"),
          border("├") + border("─".repeat(sidebarWidth)) + border("┼") + border("─".repeat(contentWidth)) + border("┤"),
        ]
      : [
          border("╭") + activeBorder("content", "─".repeat(innerWidth)) + border("╮"),
          border("│") + pad(`▶ ${title}`, innerWidth) + border("│"),
          border("├") + border("─".repeat(innerWidth)) + border("┤"),
        ];

    for (let row = 0; row < bodyHeight; row++) {
      const contentLine = content[this.contentOffset + row] ?? "";
      if (!hasSidebar) {
        lines.push(border("│") + pad(contentLine, contentWidth) + border("│"));
        continue;
      }
      const index = this.listOffset + row;
      const candidate = runs[index];
      let sidebar = candidate ? `${index === this.selected ? ">" : " "} ${candidate.report.agent} ${candidate.report.status}` : "";
      if (candidate && index === this.selected) sidebar = this.options.theme.bg("selectedBg", this.options.theme.bold(pad(sidebar, sidebarWidth)));
      lines.push(border("│") + (candidate && index === this.selected ? sidebar : pad(sidebar, sidebarWidth)) + border("│") + pad(contentLine, contentWidth) + border("│"));
    }

    const above = this.contentOffset;
    const below = Math.max(0, this.contentMaxOffset - this.contentOffset);
    const status = `${above} above · ${below} below${this.followTail ? " · following" : ""}`;
    lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
    lines.push(border("│") + pad(this.options.theme.fg("dim", `${status} · ${hasSidebar ? "h/l focus · ctrl+n/p select · " : ""}j/k · {/} ±10 · gg/G ends · q/esc close`), innerWidth) + border("│"));
    lines.push(border("╰") + border("─".repeat(innerWidth)) + border("╯"));
    return lines;
  }

  private setFocus(focus: "sidebar" | "content"): void {
    this.focus = focus;
    this.pendingG = false;
    this.options.tui.requestRender();
  }

  private moveSelection(delta: number): void {
    const runs = this.options.runs();
    if (runs.length < 2) return;
    const selected = Math.max(0, Math.min(runs.length - 1, this.selected + delta));
    if (selected === this.selected) return;
    this.selected = selected;
    this.contentOffset = 0;
    this.followTail = true;
    this.pendingG = false;
    this.options.tui.requestRender();
  }

  private scrollContent(delta: number): void {
    this.contentOffset = Math.max(0, Math.min(this.contentMaxOffset, this.contentOffset + delta));
    this.followTail = this.contentOffset === this.contentMaxOffset;
    this.options.tui.requestRender();
  }

  private scrollTo(offset: number, followTail = false): void {
    this.contentOffset = Math.max(0, Math.min(this.contentMaxOffset, offset));
    this.followTail = followTail;
    this.options.tui.requestRender();
  }

  private keepSelectionVisible(height: number): void {
    if (this.selected < this.listOffset) this.listOffset = this.selected;
    if (this.selected >= this.listOffset + height) this.listOffset = this.selected - height + 1;
  }
}
