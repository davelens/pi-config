import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ParentRequest } from "./supervision.ts";

const parentRequestSchema = Type.Object({
  questions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 4 }),
  context: Type.Optional(Type.String({ maxLength: 2000 })),
});
type ContactParentInput = Static<typeof parentRequestSchema>;

export function createContactParentTool(onRequest: (request: ParentRequest) => void): ToolDefinition {
  return {
    name: "contact_parent",
    label: "Contact Parent",
    description: "Pause and ask the parent agent 1-4 blocking questions. Call this alone only when a required decision cannot be resolved from the task or repository.",
    parameters: parentRequestSchema,
    async execute(_id: string, params: ContactParentInput) {
      onRequest(params);
      return {
        content: [{ type: "text" as const, text: "Paused. The parent agent will provide answers before you continue." }],
        details: params,
        terminate: true,
      };
    },
  };
}
