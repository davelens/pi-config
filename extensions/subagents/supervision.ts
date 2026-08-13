export interface ParentRequest {
  questions: string[];
  context?: string;
}

export function formatParentRequest(agent: string, runId: string, request: ParentRequest): string {
  return [
    `${agent} is paused and needs parent input.`,
    ...(request.context ? [`Context: ${request.context}`] : []),
    ...request.questions.map((question, index) => `${index + 1}. ${question}`),
    "Answer from established context when safe. Otherwise use ask_user_question, then resume this exact run with subagent action=resume, runId, and answer.",
    `Run ID: ${runId}`,
  ].join("\n");
}

export function formatResumePrompt(request: ParentRequest, answer: string): string {
  return [
    "# Parent response",
    ...request.questions.map((question, index) => `${index + 1}. ${question}`),
    "",
    answer.trim(),
    "",
    "Continue the original task using these answers. If another blocking decision appears, call contact_parent again.",
  ].join("\n");
}
