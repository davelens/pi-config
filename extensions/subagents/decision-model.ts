import { existsSync, readFileSync } from "node:fs";
import { getSupportedThinkingLevels, type Api, type ClassifierApi, type ClassifierContext, type ClassifierModel, type ClassifierResult, type Model, type ModelsClassifierOptions } from "@earendil-works/pi-ai";
import { atomicWrite } from "./agent-files.ts";
import type { ThinkingLevel } from "./agents.ts";

export const DECISION_TIMEOUT_MS = 5000;
const MAX_CHOICES = 255;
const DEFAULTS_CHOICE = "defaults";
export const EXCLUDED_PROVIDERS = new Set(["llamacpp", "llama.cpp", "llama-cpp"]);

export interface DecisionCandidate {
  model: Model<Api>;
  thinking: ThinkingLevel;
}

export interface DecisionChoice {
  model: string;
  thinking: ThinkingLevel;
}

export interface DecisionAgent {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinking?: ThinkingLevel;
}

export interface DecisionRequest {
  task: string;
  agent: DecisionAgent;
  candidates: DecisionCandidate[];
  signal: AbortSignal;
  timeoutMs: number;
  classifier?: ClassifierModel<ClassifierApi>;
  classify?: (classifier: ClassifierModel<ClassifierApi>, context: ClassifierContext, options: ModelsClassifierOptions) => Promise<ClassifierResult>;
}

const INSTRUCTIONS = [
  "Choose the model and thinking level for one subagent run. Each option pairs one model with one thinking level it supports; 'defaults' keeps the agent's configured model and thinking.",
  "Pick the least capable and least expensive pair that is still clearly sufficient for this task, judged from the task text, the agent's role and description, and its tools.",
  "Lookups, summaries, listings, and narrow read-only checks need a fast model with thinking off or low. Multi-file edits, debugging, refactoring, design judgment, or ambiguous requirements need stronger reasoning: prefer a capable model with medium or high thinking, and reserve xhigh or max for genuinely hard planning.",
  "Price is not a quality signal: a cheaper pair that is sufficient beats a pricier one, and a pricier pair is not automatically stronger. Prefer larger context windows only when the task implies reading a lot of material.",
  "Choose 'defaults' when no option is clearly better than the agent's configured defaults or when the task is too ambiguous to judge.",
].join(" ");

function readSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    throw new Error(`Global settings are not valid JSON: ${settingsPath}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`Global settings must be a JSON object: ${settingsPath}`);
  return settings as Record<string, unknown>;
}

export function readDecisionModel(settingsPath: string): boolean {
  const subagents = readSettings(settingsPath).subagents;
  return Boolean(subagents && typeof subagents === "object" && (subagents as Record<string, unknown>).decisionModel === true);
}

export function writeDecisionModel(settingsPath: string, enabled: boolean): void {
  const settings = readSettings(settingsPath);
  const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents) ? settings.subagents as Record<string, unknown> : {};
  settings.subagents = { ...subagents, decisionModel: enabled };
  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export type ScopedModel = { model: Model<Api>; thinkingLevel?: ThinkingLevel };

export function decisionCandidates(scoped: readonly ScopedModel[], available: readonly Model<Api>[]): DecisionCandidate[] {
  const availableIds = new Set(available.map((model) => `${model.provider}/${model.id}`));
  const pool: readonly ScopedModel[] = scoped.length ? scoped.filter(({ model }) => availableIds.has(`${model.provider}/${model.id}`)) : available.map((model) => ({ model }));
  const seen = new Set<string>();
  const candidates: DecisionCandidate[] = [];
  for (const { model, thinkingLevel } of pool) {
    const id = `${model.provider}/${model.id}`;
    if (EXCLUDED_PROVIDERS.has(model.provider) || seen.has(id)) continue;
    seen.add(id);
    const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
    const levels = thinkingLevel && supported.includes(thinkingLevel) ? [thinkingLevel] : supported;
    for (const thinking of levels) candidates.push({ model, thinking });
  }
  return candidates;
}

export async function chooseModel(request: DecisionRequest): Promise<DecisionChoice | undefined> {
  const { candidates } = request;
  if (!candidates.length) throw new Error("No routable models are available");
  if (candidates.length + 1 > MAX_CHOICES) throw new Error(`${candidates.length} model/thinking pairs exceed the ${MAX_CHOICES - 1} choice limit`);
  const options = new Map(candidates.map((candidate, index) => [`option${index}`, candidate]));
  const criteria = Object.fromEntries([...options].map(([id, { model, thinking }]) => [id, JSON.stringify({
    model: `${model.provider}/${model.id}`,
    name: model.name,
    thinking,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    costPerMillion: { input: model.cost.input, output: model.cost.output },
  })]));
  criteria[DEFAULTS_CHOICE] = JSON.stringify({ useAgentDefaults: true, model: request.agent.model ?? "parent model", thinking: request.agent.thinking ?? "Pi default" });
  const classifier = request.classifier;
  const classify = request.classify;
  if (!classifier || !classify) throw new Error("TypeSafe Jev classifier is unavailable; use /login typesafe");
  if (request.signal.aborted) throw request.signal.reason;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, request.timeoutMs))]);
  const result = await classify(classifier, {
    state: { task: request.task, agent: { name: request.agent.name, description: request.agent.description, tools: request.agent.tools } },
    questions: { route: { type: "choice", instructions: INSTRUCTIONS, criteria } },
  }, { signal });
  if (request.signal.aborted) throw request.signal.reason;
  if (signal.aborted) throw signal.reason;
  if (result.stopReason !== "stop") throw new Error(result.stopReason === "aborted" ? "TypeSafe classification was aborted" : "TypeSafe classification failed; check /login typesafe or TYPESAFE_API_KEY");
  const choice = result.answers?.route?.type === "choice" ? result.answers.route.choice : undefined;
  if (typeof choice !== "string" || (choice !== DEFAULTS_CHOICE && !options.has(choice))) throw new Error("TypeSafe returned an invalid routing answer");
  const selected = options.get(choice);
  return selected ? { model: `${selected.model.provider}/${selected.model.id}`, thinking: selected.thinking } : undefined;
}
