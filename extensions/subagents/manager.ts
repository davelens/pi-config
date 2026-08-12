import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  highlightCode,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";
import {
  createAgentDefinition,
  deleteAgentDefinition,
  renameAgentDefinition,
  restoreDefaultAgents,
  withEffectiveModel,
} from "./agent-files.ts";

function migrateOverride(settingsPath: string, oldName: string, newName: string): void {
  if (!existsSync(settingsPath)) return;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const overrides = settings.subagents?.agentOverrides;
  if (!overrides?.[oldName]) return;
  if (overrides[newName]) throw new Error(`Override '${newName}' already exists in ${settingsPath}`);
  overrides[newName] = overrides[oldName];
  delete overrides[oldName];
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function editDefinition(filePath: string, tui: TUI): boolean {
  const original = readFileSync(filePath, "utf8");
  const directory = mkdtempSync(join(tmpdir(), "pi-subagent-"));
  const editorPath = join(directory, "agent.md");
  writeFileSync(editorPath, original);

  try {
    tui.stop();
    process.stdout.write("\x1b[2J\x1b[H");
    const editor = process.env.EDITOR?.trim() || "nvim";
    const shell = process.env.SHELL || "/bin/sh";
    const result = spawnSync(shell, ["-c", `${editor} \"$1\"`, "subagent-editor", editorPath], {
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${editor} exited with code ${result.status ?? "unknown"}`);

    const updated = readFileSync(editorPath, "utf8");
    if (updated === original) return false;
    writeFileSync(filePath, updated);
    return true;
  } finally {
    tui.start();
    tui.requestRender(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

function pad(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "…");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

class NamePrompt implements Component, Focusable {
  private input = new Input();
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(private title: string, initialValue: string, private theme: Theme, done: (value?: string) => void) {
    this.input.setValue(initialValue);
    this.input.onSubmit = done;
    this.input.onEscape = () => done();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const border = (text: string) => this.theme.fg("accent", text);
    const [input = ""] = this.input.render(Math.max(1, innerWidth - 2));
    return [
      border(`╭${"─".repeat(innerWidth)}╮`),
      border("│") + pad(` ${this.theme.bold(this.title)}`, innerWidth) + border("│"),
      border("│") + pad(` ${input}`, innerWidth) + border("│"),
      border("│") + pad(this.theme.fg("dim", " enter save · esc cancel"), innerWidth) + border("│"),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
  }
}

function promptForName(tui: TUI, theme: Theme, title: string, initialValue = ""): Promise<string | undefined> {
  return new Promise((resolve) => {
    let handle: OverlayHandle;
    const done = (value?: string) => {
      handle.hide();
      resolve(value);
    };
    handle = tui.showOverlay(new NamePrompt(title, initialValue, theme, done), {
      anchor: "center",
      width: 48,
      maxHeight: 5,
    });
    tui.requestRender();
  });
}

class ConfirmPrompt implements Component {
  private confirmed = false;

  constructor(private title: string, private message: string, private action: string, private theme: Theme, private done: (confirmed: boolean) => void) {}

  handleInput(data: string): void {
    if (data === "h" || data === "y" || matchesKey(data, "left")) this.confirmed = true;
    else if (data === "l" || data === "n" || matchesKey(data, "right")) this.confirmed = false;
    else if (matchesKey(data, "enter")) this.done(this.confirmed);
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done(false);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const border = (text: string) => this.theme.fg("error", text);
    const yes = this.confirmed ? this.theme.bg("selectedBg", this.theme.bold(` ${this.action} `)) : ` ${this.action} `;
    const no = !this.confirmed ? this.theme.bg("selectedBg", this.theme.bold(" Cancel ")) : " Cancel ";
    return [
      border(`╭${"─".repeat(innerWidth)}╮`),
      border("│") + pad(` ${this.theme.bold(this.title)}`, innerWidth) + border("│"),
      border("│") + pad(` ${this.message}`, innerWidth) + border("│"),
      border("│") + pad(` ${yes}   ${no}`, innerWidth) + border("│"),
      border("│") + pad(this.theme.fg("dim", " h/l choose · enter confirm · esc cancel"), innerWidth) + border("│"),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
  }
}

function confirmAction(tui: TUI, theme: Theme, title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    let handle: OverlayHandle;
    const done = (confirmed: boolean) => {
      handle.hide();
      resolve(confirmed);
    };
    handle = tui.showOverlay(new ConfirmPrompt(title, message, action, theme, done), {
      anchor: "center",
      width: 56,
      maxHeight: 6,
    });
    tui.requestRender();
  });
}

interface ManagerOptions {
  tui: TUI;
  theme: Theme;
  agents: () => AgentConfig[];
  agentsDirectory: string;
  defaultsDirectory: string;
  settingsPaths: string[];
  done: () => void;
}

export class SubagentManager implements Component {
  private options: ManagerOptions;
  private agents: AgentConfig[];
  private selected = 0;
  private listOffset = 0;
  private contentOffset = 0;
  private focus: "sidebar" | "content" = "sidebar";
  private status = "Managing ~/.config/agents/pi";
  private statusColor: "dim" | "success" | "error" = "dim";
  private busy = false;

  constructor(options: ManagerOptions) {
    this.options = options;
    this.agents = options.agents();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.busy) return;
    if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.options.done();
    if (data === "h") return this.setFocus("sidebar");
    if (data === "l") return this.setFocus("content");
    if (matchesKey(data, "ctrl+n")) return this.moveSelection(1);
    if (matchesKey(data, "ctrl+p")) return this.moveSelection(-1);

    if (this.focus === "sidebar") {
      if (data === "j" || matchesKey(data, "down")) return this.moveSelection(1);
      if (data === "k" || matchesKey(data, "up")) return this.moveSelection(-1);
      if (data === "c") return void this.createAgent();
      if (data === "d") return void this.deleteAgent();
      if (data === "e") return void this.renameAgent();
      if (matchesKey(data, "ctrl+shift+r")) return void this.restoreDefaults();
    } else {
      if (data === "j" || matchesKey(data, "down")) return this.scrollContent(1);
      if (data === "k" || matchesKey(data, "up")) return this.scrollContent(-1);
      if (matchesKey(data, "ctrl+e")) return void this.editSelected();
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
    const innerWidth = Math.max(3, width - 2);
    const sidebarWidth = Math.max(1, Math.min(Math.floor(innerWidth * 0.3), innerWidth - 2));
    const contentWidth = innerWidth - sidebarWidth - 1;
    const bodyHeight = Math.max(1, height - 7);
    const border = (text: string) => this.options.theme.fg("border", text);
    const activeBorder = (section: "sidebar" | "content", text: string) =>
      this.options.theme.fg(this.focus === section ? "accent" : "border", text);

    const current = this.currentAgent();
    const highlighted = current
      ? highlightCode(withEffectiveModel(readFileSync(current.filePath, "utf8"), current.model), "markdown")
        .flatMap((line) => wrapTextWithAnsi(line, contentWidth))
      : ["No agents configured"];
    this.contentOffset = Math.min(this.contentOffset, Math.max(0, highlighted.length - bodyHeight));
    this.keepSelectionVisible(bodyHeight);

    const lines = [
      border("╭") + activeBorder("sidebar", "─".repeat(sidebarWidth)) + border("┬") + activeBorder("content", "─".repeat(contentWidth)) + border("╮"),
      border("│") + pad(`${this.focus === "sidebar" ? "▶ " : "  "}Subagents`, sidebarWidth) + border("│") + pad(`${this.focus === "content" ? "▶ " : "  "}${current?.filePath ?? "No file"}`, contentWidth) + border("│"),
      border("├") + border("─".repeat(sidebarWidth)) + border("┼") + border("─".repeat(contentWidth)) + border("┤"),
    ];

    for (let row = 0; row < bodyHeight; row++) {
      const index = this.listOffset + row;
      const agent = this.agents[index];
      let sidebar = "";
      if (agent) {
        sidebar = `${index === this.selected ? ">" : " "} ${agent.name}`;
        if (index === this.selected) sidebar = this.options.theme.bg("selectedBg", this.options.theme.bold(pad(sidebar, sidebarWidth)));
      }
      const content = highlighted[this.contentOffset + row] ?? "";
      lines.push(border("│") + (index === this.selected && agent ? sidebar : pad(sidebar, sidebarWidth)) + border("│") + pad(content, contentWidth) + border("│"));
    }

    lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
    lines.push(border("│") + pad(this.options.theme.fg(this.statusColor, this.status), innerWidth) + border("│"));
    lines.push(border("│") + pad(this.options.theme.fg("dim", "ctrl+shift+r restore · c create · d delete · e rename · ctrl+e edit · h/l focus · j/k navigate · q/esc close"), innerWidth) + border("│"));
    lines.push(border("╰") + border("─".repeat(innerWidth)) + border("╯"));
    return lines;
  }

  private currentAgent(): AgentConfig | undefined {
    return this.agents[this.selected];
  }

  private setFocus(focus: "sidebar" | "content"): void {
    this.focus = focus;
    this.options.tui.requestRender();
  }

  private moveSelection(delta: number): void {
    if (!this.agents.length) return;
    this.selected = Math.max(0, Math.min(this.agents.length - 1, this.selected + delta));
    this.contentOffset = 0;
    this.options.tui.requestRender();
  }

  private scrollContent(delta: number): void {
    this.contentOffset = Math.max(0, this.contentOffset + delta);
    this.options.tui.requestRender();
  }

  private keepSelectionVisible(height: number): void {
    if (this.selected < this.listOffset) this.listOffset = this.selected;
    if (this.selected >= this.listOffset + height) this.listOffset = this.selected - height + 1;
  }

  private refresh(selectedName?: string): void {
    this.agents = this.options.agents();
    if (selectedName) {
      const index = this.agents.findIndex(({ name }) => name === selectedName);
      if (index >= 0) this.selected = index;
    }
    this.selected = Math.min(this.selected, Math.max(0, this.agents.length - 1));
    this.contentOffset = 0;
    this.options.tui.requestRender(true);
  }

  private feedback(message: string, color: "success" | "error"): void {
    this.status = `${color === "success" ? "✓" : "✗"} ${message}`;
    this.statusColor = color;
    this.options.tui.requestRender();
  }

  private async createAgent(): Promise<void> {
    this.busy = true;
    try {
      const name = (await promptForName(this.options.tui, this.options.theme, "New subagent"))?.trim();
      if (!name) return;
      if (this.agents.some((agent) => agent.name === name)) throw new Error(`Subagent '${name}' already exists`);
      const filePath = createAgentDefinition(this.options.agentsDirectory, name);
      this.refresh(name);
      try {
        const changed = editDefinition(filePath, this.options.tui);
        this.feedback(`Created ${name}${changed ? " and saved its definition" : ""}`, "success");
      } catch (error) {
        this.feedback(`Created ${name}, but editor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } catch (error) {
      this.feedback(`Could not create subagent: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.busy = false;
    }
  }

  private async renameAgent(): Promise<void> {
    const agent = this.currentAgent();
    if (!agent) return;
    this.busy = true;
    try {
      const name = (await promptForName(this.options.tui, this.options.theme, "Rename subagent", agent.name))?.trim();
      if (!name || name === agent.name) return;
      if (this.agents.some((candidate) => candidate.name === name)) throw new Error(`Subagent '${name}' already exists`);
      renameAgentDefinition(agent.filePath, name);
      try {
        for (const settingsPath of this.options.settingsPaths) migrateOverride(settingsPath, agent.name, name);
      } catch (error) {
        this.refresh(name);
        this.feedback(`Renamed ${agent.name}, but could not migrate its override: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      this.refresh(name);
      this.feedback(`Renamed ${agent.name} to ${name}`, "success");
    } catch (error) {
      this.feedback(`Could not rename subagent: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.busy = false;
    }
  }

  private async deleteAgent(): Promise<void> {
    const agent = this.currentAgent();
    if (!agent) return;
    this.busy = true;
    try {
      const confirmed = await confirmAction(this.options.tui, this.options.theme, `Delete ${agent.name}?`, "This permanently deletes its Markdown file.", "Delete");
      if (!confirmed) return;
      deleteAgentDefinition(agent.filePath);
      this.refresh();
      this.feedback(`Deleted ${agent.name}`, "success");
    } catch (error) {
      this.feedback(`Could not delete subagent: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.busy = false;
    }
  }

  private async restoreDefaults(): Promise<void> {
    this.busy = true;
    try {
      const confirmed = await confirmAction(this.options.tui, this.options.theme, "Restore default agents?", "This deletes every managed subagent file.", "Restore");
      if (!confirmed) return;
      restoreDefaultAgents(this.options.defaultsDirectory, this.options.agentsDirectory);
      this.refresh();
      this.feedback("Restored default agents", "success");
    } catch (error) {
      this.feedback(`Could not restore defaults: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.busy = false;
    }
  }

  private async editSelected(): Promise<void> {
    const agent = this.currentAgent();
    if (!agent) return;
    this.busy = true;
    try {
      if (editDefinition(agent.filePath, this.options.tui)) {
        this.refresh(agent.name);
        this.feedback(`Updated ${agent.name}`, "success");
      } else {
        this.feedback(`No changes to ${agent.name}`, "success");
      }
    } catch (error) {
      this.feedback(`Could not edit subagent: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.busy = false;
    }
  }
}
