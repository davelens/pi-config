import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const QUESTIONNAIRE_MODULE = join(getAgentDir(), "npm", "node_modules", "@juicesharp", "rpiv-ask-user-question", "ask-user-question.ts");

export interface ParentQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
}

export interface ParentRequest {
  questions: ParentQuestion[];
}

type ParentAnswer =
  | { status: "answered"; text: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

interface QuestionnaireDetails {
  cancelled: boolean;
  error?: string;
}

/** A blocking child question the user declined (aborted) or the parent UI could not show (failed). */
export class ParentQuestionError extends Error {
  constructor(readonly status: "aborted" | "failed", message: string) {
    super(message);
  }
}

/**
 * Capture the installed ask_user_question tool through its own registration function so the
 * questionnaire UI, validation, and result envelope are the real ones; rpiv only exports the registrar.
 */
export async function loadQuestionnaire(pi: ExtensionAPI): Promise<ToolDefinition> {
  let tool: ToolDefinition | undefined;
  try {
    const { registerAskUserQuestionTool } = await import(pathToFileURL(QUESTIONNAIRE_MODULE).href) as { registerAskUserQuestionTool(pi: ExtensionAPI): void };
    registerAskUserQuestionTool({ registerTool: (definition: ToolDefinition) => { tool = definition; }, events: pi.events } as unknown as ExtensionAPI);
  } catch (error) {
    throw new Error(`Parent questionnaire is unavailable (${QUESTIONNAIRE_MODULE}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!tool) throw new Error(`Parent questionnaire did not register a tool (${QUESTIONNAIRE_MODULE})`);
  return tool;
}

/** Show the questionnaire in the parent UI; an aborted signal dismisses the overlay and reads as cancelled. */
export async function askParent(questionnaire: ToolDefinition, ctx: ExtensionContext, request: ParentRequest, signal: AbortSignal): Promise<ParentAnswer> {
  const dismissed = { answers: [], cancelled: true };
  let close: ((result: unknown) => void) | undefined;
  let dismiss: (() => void) | undefined;
  const custom: ExtensionContext["ui"]["custom"] = (factory, options) => Promise.race([
    ctx.ui.custom((tui, theme, keybindings, done) => {
      close = done;
      if (signal.aborted) done(dismissed);
      return factory(tui, theme, keybindings, done);
    }, options),
    new Promise<never>((_resolve, reject) => {
      dismiss = () => {
        close?.(dismissed);
        reject(signal.reason);
      };
      signal.addEventListener("abort", dismiss, { once: true });
    }),
  ]);
  const ui: ExtensionContext["ui"] = Object.create(ctx.ui, { custom: { value: custom } });
  if (typeof ctx.ui.select === "function") ui.select = (title, options, opts) => ctx.ui.select(title, options, { ...opts, signal });
  if (typeof ctx.ui.input === "function") ui.input = (title, placeholder, opts) => ctx.ui.input(title, placeholder, { ...opts, signal });
  try {
    signal.throwIfAborted();
    const result = await questionnaire.execute("contact-parent", request, signal, undefined, Object.create(ctx, { ui: { value: ui } }));
    const details = result.details as QuestionnaireDetails;
    const text = result.content.map((part) => part.type === "text" ? part.text : "").join("");
    if (details.error) return { status: "error", message: text };
    if (details.cancelled) return { status: "cancelled" };
    return { status: "answered", text };
  } catch (error) {
    if (signal.aborted) return { status: "cancelled" };
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (dismiss) signal.removeEventListener("abort", dismiss);
  }
}

export function formatQuestions(request: ParentRequest): string[] {
  return request.questions.map((question) => question.question);
}

export function createContactParentTool(questionnaire: ToolDefinition, ask: (request: ParentRequest, signal: AbortSignal) => Promise<string>): ToolDefinition {
  return {
    name: "contact_parent",
    label: "Contact Parent",
    description: "Pause and ask the user 1-4 blocking questions through the parent UI (2-4 options each, plus an automatic free-text row). Call this alone only when a required decision cannot be resolved from the task or repository; cancelling stops your run.",
    parameters: questionnaire.parameters,
    async execute(_id: string, params: ParentRequest, signal?: AbortSignal) {
      const text = await ask(params, signal ?? new AbortController().signal);
      return { content: [{ type: "text" as const, text }], details: params };
    },
  };
}
