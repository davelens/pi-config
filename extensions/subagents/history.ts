import { readFileSync } from "node:fs";
import { parseSessionEntries, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunReport } from "./reports.ts";
import type { StatusRun } from "./status.ts";

export const HISTORY_ENTRY = "subagent-run-history";

interface HistoryEntry {
  parentSessionId: string;
  report: RunReport;
}

export function loadRunHistory(session: ExtensionContext["sessionManager"], live: ReadonlyMap<string, StatusRun>): StatusRun[] {
  const latest = new Map<string, RunReport>();
  // This is a session-wide audit trail, including abandoned branches, not model context.
  for (const entry of session.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== HISTORY_ENTRY) continue;
    const data = entry.data as HistoryEntry | undefined;
    if (data?.parentSessionId === session.getSessionId() && data.report?.id) {
      latest.set(data.report.id, structuredClone(data.report));
    }
  }
  return [...latest.values()].map((report) => {
    const active = live.get(report.id);
    if (active && (active.report.status === "running" || active.report.status === "waiting")) return active;
    if (report.status === "running" || report.status === "waiting") {
      report.status = "aborted";
      report.error = "Interrupted before the run completed; this historical record is not live.";
    }
    const messages: StatusRun["messages"] = [];
    const unavailable: string[] = [];
    for (const path of report.sessionPaths) {
      try {
        const entries = parseSessionEntries(readFileSync(path, "utf8"));
        const transcript = entries.filter((entry) => entry.type === "message")
          .map((entry) => entry.message).filter((message) => message.role !== "system");
        if (!transcript.length) throw new Error("No saved messages");
        messages.push(...transcript);
      } catch {
        unavailable.push(path);
      }
    }
    if (!messages.length) messages.push({ role: "user", content: report.task });
    if (unavailable.length) messages.push({ role: "history", content: `Child transcript unavailable:\n${unavailable.join("\n")}` });
    if (report.output !== undefined && (!report.sessionPaths.length || unavailable.length)) {
      messages.push({ role: "report", content: report.output });
    }
    if (report.error) messages.push({ role: "error", content: report.error });
    return { report, messages };
  });
}
