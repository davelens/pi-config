import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { atomicWrite } from "./agent-files.ts";

function validateKey(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value.trim())) {
    throw new Error("TypeSafe API key must be nonempty and contain no whitespace or control characters");
  }
  return value.trim();
}

export function readTypeSafeKey(path: string): string | undefined {
  const environmentKey = process.env.TYPESAFE_API_KEY?.trim();
  if (environmentKey) return validateKey(environmentKey);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Could not read the TypeSafe credentials file");
  }
  try {
    return validateKey(JSON.parse(content)?.apiKey);
  } catch {
    throw new Error("Invalid TypeSafe credentials file; use /subagent-decision-model key to replace it");
  }
}

export function writeTypeSafeKey(path: string, key: string): void {
  const apiKey = validateKey(key);
  try {
    atomicWrite(path, `${JSON.stringify({ apiKey })}\n`, 0o600);
  } catch {
    throw new Error("Could not save the TypeSafe credentials file");
  }
}

export async function promptTypeSafeKey(ctx: ExtensionContext): Promise<string | undefined> {
  if (ctx.mode !== "tui") throw new Error("Set TYPESAFE_API_KEY or run /subagent-decision-model on in the TUI to save a key");
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const input = new Input();
    input.onSubmit = (value) => done(value.trim() || undefined);
    input.onEscape = () => done(undefined);
    return {
      render: (width) => [
        theme.fg("accent", truncateToWidth("TypeSafe API key (hidden)", width)),
        truncateToWidth(input.getValue() ? "> Key entered (hidden)" : "> Paste or type your key", width),
        theme.fg("dim", truncateToWidth("Enter: save locally (owner-only file) · Esc: cancel", width)),
      ],
      handleInput: (data) => {
        if (matchesKey(data, "ctrl+c")) done(undefined);
        else input.handleInput(data);
        tui.requestRender();
      },
      invalidate: () => input.invalidate(),
    };
  });
}
