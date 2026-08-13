import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { streamJump } from "./run-stream.ts";

function pad(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "…");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export class SubagentsDoctor implements Component {
  private offset = 0;
  private maxOffset = 0;
  private pendingG = false;
  private tui: TUI;
  private theme: Theme;
  private report: string;
  private done: () => void;

  constructor(tui: TUI, theme: Theme, report: string, done: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.report = report;
    this.done = done;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done();
    const navigation = streamJump(data, this.pendingG);
    this.pendingG = navigation.pendingG;
    if (navigation.jump === "top") return this.scrollTo(0);
    if (navigation.jump === "bottom") return this.scrollTo(this.maxOffset);
    if (typeof navigation.jump === "number") return this.scroll(navigation.jump);
    if (data === "g") return;
    if (data === "j" || matchesKey(data, "down")) return this.scroll(1);
    if (data === "k" || matchesKey(data, "up")) return this.scroll(-1);
    if (matchesKey(data, "pageDown")) return this.scroll(10);
    if (matchesKey(data, "pageUp")) return this.scroll(-10);
    if (matchesKey(data, "home")) return this.scrollTo(0);
    if (matchesKey(data, "end")) return this.scrollTo(this.maxOffset);
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    const panelWidth = Math.min(width, Math.max(5, Math.floor(width * 0.7)));
    const panelHeight = Math.min(rows, Math.max(8, Math.floor(rows * 0.7)));
    const panel = this.renderPanel(panelWidth, panelHeight);
    const top = Math.max(0, Math.floor((rows - panel.length) / 2));
    const left = Math.max(0, Math.floor((width - panelWidth) / 2));
    const backdrop = this.theme.bg("userMessageBg", " ".repeat(width));
    const lines = Array.from({ length: rows }, () => backdrop);

    for (let index = 0; index < panel.length && top + index < lines.length; index++) {
      const panelLine = truncateToWidth(panel[index] ?? "", panelWidth, "");
      lines[top + index] = this.theme.bg("userMessageBg", " ".repeat(left))
        + pad(panelLine, panelWidth)
        + this.theme.bg("userMessageBg", " ".repeat(Math.max(0, width - left - panelWidth)));
    }
    return lines;
  }

  private renderPanel(width: number, height: number): string[] {
    const innerWidth = Math.max(3, width - 2);
    const bodyHeight = Math.max(1, height - 6);
    const border = (text: string) => this.theme.fg("border", text);
    const content = this.report.split("\n").flatMap((line) => {
      const styled = line.startsWith("# ")
        ? this.theme.fg("accent", this.theme.bold(line.slice(2)))
        : line.startsWith("## ")
          ? this.theme.fg("accent", this.theme.bold(line.slice(3)))
          : line.includes("✗")
            ? this.theme.fg("error", line)
            : line.includes("!")
              ? this.theme.fg("warning", line)
              : line.includes("✓")
                ? this.theme.fg("success", line)
                : line;
      return wrapTextWithAnsi(styled, innerWidth);
    });
    this.maxOffset = Math.max(0, content.length - bodyHeight);
    this.offset = Math.min(this.offset, this.maxOffset);
    const lines = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      border("│") + pad(` ${this.theme.bold("Subagents doctor")}`, innerWidth) + border("│"),
      border(`├${"─".repeat(innerWidth)}┤`),
    ];
    for (let row = 0; row < bodyHeight; row++) lines.push(border("│") + pad(content[this.offset + row] ?? "", innerWidth) + border("│"));
    lines.push(border(`├${"─".repeat(innerWidth)}┤`));
    lines.push(border("│") + pad(this.theme.fg("dim", `${this.offset} above · ${this.maxOffset - this.offset} below · j/k · {/} ±10 · gg/G ends · q/esc close`), innerWidth) + border("│"));
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  private scroll(delta: number): void {
    this.scrollTo(this.offset + delta);
  }

  private scrollTo(offset: number): void {
    this.offset = Math.max(0, Math.min(this.maxOffset, offset));
    this.tui.requestRender();
  }
}
