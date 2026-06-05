import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@mariozechner/pi-coding-agent";
import { Container, Input, matchesKey, Text, truncateToWidth, visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { existsSync, unlinkSync } from "node:fs";

const MAX_SESSION_NAME_WORDS = 10;

// Catppuccin Mocha-specific rule colors requested for this config.
// Keep these centralized because they intentionally bypass Pi's generic theme names.
const CATPPUCCIN_MOCHA_BASE_BG = "\x1b[48;2;30;30;46m";
const CATPPUCCIN_MOCHA_SURFACE0_FG = "\x1b[38;2;49;50;68m";
const ANSI_RESET = "\x1b[0m";

type SwitchResult =
  | { action: "switch"; path: string }
  | { action: "cancel" };

function wordLimit(text: string, maxWords = MAX_SESSION_NAME_WORDS): string {
  const cleaned = text
    .replace(/["'`]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?:;,]+$/, "");
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ") || "Untitled session";
}

function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function persistSessionName(
  sessionPath: string,
  nextName: string,
  currentSessionPath: string | undefined,
  setCurrentSessionName: (name: string) => void,
): string {
  const sessionName = wordLimit(nextName);
  if (currentSessionPath && sessionPath === currentSessionPath) {
    setCurrentSessionName(sessionName);
  } else {
    SessionManager.open(sessionPath).appendSessionInfo(sessionName);
  }
  return sessionName;
}

class BlankLine implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return [" ".repeat(width)];
  }
}

class IndentedInput implements Component {
  constructor(private input: Input, private indent = 1) {}

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const prefix = " ".repeat(this.indent);
    return this.input.render(Math.max(1, width - this.indent)).map((line) => prefix + line);
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

function stripTerminalColorReports(data: string): string {
  // Some terminals reply to OSC 10/11/12 color queries on stdin. If that
  // response arrives while this custom UI owns input, the printable tail can
  // otherwise end up in the filter/rename input.
  return data.replace(/(?:\x1b)?\](?:10|11|12);rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\)?/g, "");
}

function fuzzyScore(text: string, query: string): number {
  if (!query.trim()) return 1;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase().trim();
  let score = 0;
  let lastIndex = -1;

  for (const char of needle) {
    const index = haystack.indexOf(char, lastIndex + 1);
    if (index === -1) return 0;
    score += index === lastIndex + 1 ? 3 : 1;
    lastIndex = index;
  }

  return score;
}

class SwitchSessionComponent implements Component {
  private selectedIndex = 0;
  private mode: "list" | "rename" | "confirmDelete" = "list";
  private searchInput = new Input();
  private renameInput = new Input();
  private filteredSessions: SessionInfo[];
  private status: string | undefined;
  private deleteChoice: "yes" | "no" = "no";

  constructor(
    private sessions: SessionInfo[],
    private currentSessionPath: string | undefined,
    private theme: ExtensionCommandContext["ui"]["theme"],
    private getRows: () => number,
    private persistName: (sessionPath: string, nextName: string) => string,
    private done: (result: SwitchResult) => void,
  ) {
    this.filteredSessions = [...sessions];
    this.searchInput.onSubmit = () => this.switchSelected();
    this.renameInput.onSubmit = (value) => this.finishRename(value);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const panelWidth = Math.max(1, Math.min(112, width - 8));
    const contentLines = this.mode === "confirmDelete"
      ? this.renderDeleteDialog(panelWidth)
      : this.renderPanel(panelWidth);
    const contentWidth = Math.max(...contentLines.map((line) => visibleWidth(line)), panelWidth);
    const height = Math.max(contentLines.length, this.getRows());
    const topPadding = Math.max(0, Math.floor((height - contentLines.length) / 2));
    const leftPadding = Math.max(0, Math.floor((width - contentWidth) / 2));
    const backdrop = this.theme.bg("userMessageBg", " ".repeat(width));
    const lines = Array.from({ length: height }, () => backdrop);

    for (let i = 0; i < contentLines.length && topPadding + i < lines.length; i++) {
      lines[topPadding + i] = this.compositeLine(width, leftPadding, contentWidth, contentLines[i] ?? "");
    }

    return lines;
  }

  private compositeLine(width: number, leftPadding: number, panelWidth: number, line: string): string {
    const panelLine = truncateToWidth(line, panelWidth, "");
    const paddedPanel = panelLine + " ".repeat(Math.max(0, panelWidth - visibleWidth(panelLine)));
    const left = this.theme.bg("userMessageBg", " ".repeat(leftPadding));
    const rightWidth = Math.max(0, width - leftPadding - panelWidth);
    const right = this.theme.bg("userMessageBg", " ".repeat(rightWidth));
    return left + paddedPanel + right;
  }

  private box(lines: string[], width: number, color: "accent" | "error"): string[] {
    const innerWidth = Math.max(1, width - 2);
    const top = this.theme.fg(color, "┌" + "─".repeat(innerWidth) + "┐");
    const bottom = this.theme.fg(color, "└" + "─".repeat(innerWidth) + "┘");
    const paddedLines = [...lines];
    const footerLines = color === "accent" && paddedLines.length >= 2 ? paddedLines.splice(-2) : [];
    while (paddedLines.length + footerLines.length < 15) {
      paddedLines.push(" ".repeat(innerWidth));
    }
    paddedLines.push(...footerLines);
    const body = paddedLines.map((line) => {
      const truncated = truncateToWidth(line, innerWidth, "");
      const padded = truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
      return this.theme.fg(color, "│") + padded + this.theme.fg(color, "│");
    });
    return [top, ...body, bottom];
  }

  private renderPanel(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const innerWidth = Math.max(1, contentWidth - 4);
    const container = new Container();
    container.addChild(new Text(this.headerLine(innerWidth), 2, 0));
    container.addChild(new Text(this.footerRule(innerWidth), 2, 0));

    if (this.mode === "rename") {
      container.addChild(new BlankLine());
      container.addChild(new Text(this.theme.fg("accent", "Rename session"), 2, 0));
      container.addChild(new IndentedInput(this.renameInput, 2));
      container.addChild(new Text(this.footerRule(innerWidth), 2, 0));
      container.addChild(new Text(this.theme.fg("dim", "Enter saves · Esc cancels"), 2, 0));
      return this.box(container.render(contentWidth), width, "accent");
    }

    container.addChild(new IndentedInput(this.searchInput, 2));
    container.addChild(new BlankLine());

    if (this.status) {
      container.addChild(new Text(this.theme.fg("warning", this.status), 2, 0));
    }

    container.addChild(new Text(this.columnHeader(innerWidth), 2, 0));

    const visible = this.visibleSessions();
    if (visible.length === 0) {
      container.addChild(new Text(this.theme.fg("muted", "  No sessions match this search."), 2, 0));
    } else {
      for (const { session, index } of visible) {
        container.addChild(new Text(this.renderSessionLine(session, index, innerWidth), 2, 0));
      }
      if (this.filteredSessions.length > 8) {
        container.addChild(new Text(this.theme.fg("muted", `  ${this.selectedIndex + 1}/${this.filteredSessions.length}`), 2, 0));
      }
    }

    container.addChild(new Text(this.footerRule(innerWidth), 2, 0));
    container.addChild(new Text(this.footerLegend(innerWidth), 2, 0));

    return this.box(container.render(contentWidth), width, "accent");
  }

  private renderDeleteDialog(width: number): string[] {
    const selected = this.selectedSession();
    const sessionName = wordLimit(selected?.name || selected?.firstMessage || "this session");
    const contentWidth = Math.max(1, width - 2);
    const container = new Container();
    container.addChild(new Text(this.theme.fg("error", this.theme.bold("Delete session?")), 2, 0));
    container.addChild(new Text(this.errorRule(Math.max(1, width - 7)), 2, 0));
    container.addChild(new Text(truncateToWidth(`Are you sure you wish to delete “${sessionName}”?`, Math.max(1, width - 4), "…"), 2, 0));
    container.addChild(new BlankLine());
    container.addChild(new Text(this.deleteButtons(Math.max(1, width - 4)), 2, 0));
    return this.box(container.render(contentWidth), width, "error");
  }

  handleInput(data: string): void {
    data = stripTerminalColorReports(data);
    if (!data) return;

    if (this.mode === "rename") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.mode = "list";
        return;
      }
      this.renameInput.handleInput(data);
      return;
    }

    if (this.mode === "confirmDelete") {
      if (data.toLowerCase() === "h" || matchesKey(data, "left")) {
        this.deleteChoice = "yes";
        return;
      }
      if (data.toLowerCase() === "l" || matchesKey(data, "right")) {
        this.deleteChoice = "no";
        return;
      }
      if (matchesKey(data, "enter")) {
        if (this.deleteChoice === "yes") this.deleteSelected();
        else this.mode = "list";
        return;
      }
      if (data.toLowerCase() === "y") {
        this.deleteSelected();
        return;
      }
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data.toLowerCase() === "n" || data.toLowerCase() === "q") {
        this.mode = "list";
        return;
      }
      return;
    }

    if (matchesKey(data, "ctrl+n") || matchesKey(data, "down")) {
      this.move(1);
    } else if (matchesKey(data, "ctrl+p") || matchesKey(data, "up")) {
      this.move(-1);
    } else if (matchesKey(data, "pageDown")) {
      this.move(10);
    } else if (matchesKey(data, "pageUp")) {
      this.move(-10);
    } else if (matchesKey(data, "enter")) {
      this.switchSelected();
    } else if (matchesKey(data, "ctrl+c")) {
      if (this.searchInput.getValue().length > 0) {
        this.searchInput.setValue("");
        this.applyFilter();
        return;
      }
      this.done({ action: "cancel" });
    } else if (matchesKey(data, "escape")) {
      this.done({ action: "cancel" });
    } else if (matchesKey(data, "ctrl+r")) {
      this.startRename();
    } else if (matchesKey(data, "ctrl+d")) {
      this.startDeleteConfirmation();
    } else {
      this.searchInput.handleInput(data);
      this.applyFilter();
    }
  }

  private headerLine(width: number): string {
    const title = this.theme.bold("Switch session");
    const scope = this.theme.fg("muted", "Current project");
    const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(scope));
    return truncateToWidth(title + " ".repeat(spacing) + scope, width, "…");
  }

  private footerRule(width: number): string {
    return `${CATPPUCCIN_MOCHA_SURFACE0_FG}${CATPPUCCIN_MOCHA_BASE_BG}${"─".repeat(width)}${ANSI_RESET}`;
  }

  private errorRule(width: number): string {
    return this.theme.fg("error", "─".repeat(width));
  }

  private deleteButtons(width: number): string {
    const yes = this.deleteChoice === "yes" ? this.theme.bg("selectedBg", this.theme.bold("  Yes  ")) : "  Yes  ";
    const no = this.deleteChoice === "no" ? this.theme.bg("selectedBg", this.theme.bold("  No  ")) : "  No  ";
    const gap = "      ";
    const buttons = yes + gap + no;
    const padding = Math.max(0, Math.floor((width - visibleWidth(buttons)) / 2));
    return " ".repeat(padding) + buttons;
  }

  private footerLegend(width: number): string {
    return this.theme.fg("dim", truncateToWidth("Rename session: ctrl+r  ∙  Delete session: ctrl+d", width, "…"));
  }

  private columnHeader(width: number): string {
    const left = this.theme.fg("dim", "  Session");
    const right = this.theme.fg("dim", "Msgs  Age");
    const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return left + " ".repeat(spacing) + right;
  }

  private visibleSessions(): Array<{ session: SessionInfo; index: number }> {
    const maxVisible = 8;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredSessions.length - maxVisible));
    const end = Math.min(start + maxVisible, this.filteredSessions.length);
    return this.filteredSessions.slice(start, end).map((session, offset) => ({ session, index: start + offset }));
  }

  private renderSessionLine(session: SessionInfo, index: number, width: number): string {
    const selected = index === this.selectedIndex;
    const current = this.currentSessionPath === session.path;
    const cursor = selected ? this.theme.fg("accent", "> ") : "  ";
    const sessionName = wordLimit(session.name || session.firstMessage);
    const msgCount = String(session.messageCount).padStart(4, " ");
    const age = formatAge(session.modified).padStart(4, " ");
    const right = `${msgCount} ${age}`;
    const tag = current ? "current  " : "";
    const available = Math.max(10, width - visibleWidth(cursor) - visibleWidth(right) - visibleWidth(tag) - 2);
    let left = cursor + truncateToWidth(sessionName, available, "…");
    if (current) left = this.theme.fg("accent", left);
    if (selected) left = this.theme.bold(left);
    const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - visibleWidth(tag));
    let line = left + " ".repeat(spacing) + this.theme.fg("dim", tag + right);
    if (selected) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width, "");
  }

  private move(delta: number): void {
    if (this.filteredSessions.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.filteredSessions.length - 1, this.selectedIndex + delta));
  }

  private selectedSession(): SessionInfo | undefined {
    return this.filteredSessions[this.selectedIndex];
  }

  private switchSelected(): void {
    const selected = this.selectedSession();
    if (selected) this.done({ action: "switch", path: selected.path });
  }

  private startRename(): void {
    const selected = this.selectedSession();
    if (!selected) return;
    this.renameInput.setValue(wordLimit(selected.name || selected.firstMessage));
    this.mode = "rename";
  }

  private finishRename(value: string): void {
    const selected = this.selectedSession();
    if (!selected) return;
    const sessionName = wordLimit(value);
    selected.name = this.persistName(selected.path, sessionName);
    this.applyFilter(false);
    this.mode = "list";
    this.status = "Renamed session";
  }

  private startDeleteConfirmation(): void {
    const selected = this.selectedSession();
    if (!selected) return;
    if (selected.path === this.currentSessionPath) {
      this.status = "Cannot delete the currently active session";
      return;
    }
    this.deleteChoice = "no";
    this.mode = "confirmDelete";
  }

  private deleteSelected(): void {
    const selected = this.selectedSession();
    if (!selected) return;
    if (selected.path === this.currentSessionPath) {
      this.status = "Cannot delete the currently active session";
      this.mode = "list";
      return;
    }

    try {
      if (existsSync(selected.path)) {
        unlinkSync(selected.path);
      }
      this.sessions = this.sessions.filter((session) => session.path !== selected.path);
      this.applyFilter(false);
    } catch (error) {
      this.status = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.mode = "list";
    }
  }

  private applyFilter(resetSelection = true): void {
    const query = this.searchInput.getValue().trim();
    if (!query) {
      this.filteredSessions = [...this.sessions];
    } else {
      const tokens = query.split(/\s+/).filter(Boolean);
      this.filteredSessions = this.sessions
        .map((session) => {
          const searchable = `${session.name ?? ""} ${session.firstMessage}`;
          const tokenScores = tokens.map((token) => fuzzyScore(searchable, token));
          return { session, score: tokenScores.reduce((sum, score) => sum + score, 0), matches: tokenScores.every((score) => score > 0) };
        })
        .filter(({ matches }) => matches)
        .sort((a, b) => b.score - a.score || b.session.modified.getTime() - a.session.modified.getTime())
        .map(({ session }) => session);
    }

    this.selectedIndex = resetSelection ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
  }
}

async function showSwitchSessionUi(sessions: SessionInfo[], ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<SwitchResult> {
  return await ctx.ui.custom<SwitchResult>((tui: TUI, theme, _keybindings, done) => {
    return new SwitchSessionComponent(
      sessions,
      ctx.sessionManager.getSessionFile(),
      theme,
      () => tui.terminal.rows,
      (sessionPath, nextName) => persistSessionName(sessionPath, nextName, ctx.sessionManager.getSessionFile(), (name) => pi.setSessionName(name)),
      done,
    );
  }, {
    overlay: true,
    overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("switch-session", {
    description: "Switch project sessions with manual renaming",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      await ctx.waitForIdle();

      const sessions = (await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()))
        .filter((session) => !session.parentSessionPath);
      sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

      const result = await showSwitchSessionUi(sessions, ctx, pi);
      if (result.action !== "switch") return;

      await ctx.switchSession(result.path, {
        withSession: async (newCtx) => {
          newCtx.ui.notify("Switched session", "info");
        },
      });
    },
  });
}
