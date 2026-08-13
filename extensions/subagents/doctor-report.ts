interface DoctorAgent {
  name: string;
  filePath: string;
  model: string;
  fallbackModels?: string[];
  tools: string[];
  skills?: string[];
  issues: string[];
}

export function buildDoctorReport(input: {
  agents: DoctorAgent[];
  definitionDiagnostics: string[];
  skillDiagnostics: string[];
  availableSkills: string[];
  guardrailsAvailable: boolean;
  guardrailDiagnostics?: string[];
  agentsDirectory: string;
  reportsDirectory: string;
  activeRuns: number;
}): string {
  const lines = [
    "# Subagents doctor",
    "",
    "## Runtime",
    `- ${input.guardrailsAvailable ? "✓" : "✗"} guardrails: ${input.guardrailsAvailable ? "available" : "unavailable"}`,
    ...(input.guardrailDiagnostics ?? []).map((diagnostic) => `- ! ${diagnostic}`),
    `- ✓ agents: ${input.agentsDirectory}`,
    `- ✓ reports: ${input.reportsDirectory}`,
    `- ${input.activeRuns} active run${input.activeRuns === 1 ? "" : "s"}`,
    "",
    "## Agents",
    ...input.agents.map((agent) => {
      const details = [
        `model=${agent.model}`,
        ...(agent.fallbackModels?.length ? [`fallbacks=${agent.fallbackModels.join(",")}`] : []),
        `tools=${agent.tools.join(",")}`,
        ...(agent.skills?.length ? [`skills=${agent.skills.join(",")}`] : []),
      ].join("; ");
      return `- ${agent.issues.length ? "!" : "✓"} ${agent.name} — ${details}${agent.issues.length ? ` — ${agent.issues.join("; ")}` : ""}`;
    }),
    "",
    "## Skills",
    `- available: ${input.availableSkills.join(", ") || "none"}`,
    ...input.skillDiagnostics.map((diagnostic) => `- ! ${diagnostic}`),
    "",
    "## Definition diagnostics",
    ...(input.definitionDiagnostics.length ? input.definitionDiagnostics.map((diagnostic) => `- ! ${diagnostic}`) : ["- ✓ none"]),
  ];
  return lines.join("\n");
}
