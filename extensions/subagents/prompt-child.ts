interface PromptSession {
  abort(): void | Promise<void>;
  prompt(prompt: string): Promise<void>;
}

export async function promptChild(session: PromptSession, prompt: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const turnSignal = AbortSignal.any([signal, timeoutSignal]);
  const abort = () => void session.abort();
  turnSignal.addEventListener("abort", abort, { once: true });
  try {
    turnSignal.throwIfAborted();
    await session.prompt(prompt);
  } catch (error) {
    if (timeoutSignal.aborted && !signal.aborted) throw new Error(`Subagent attempt timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    turnSignal.removeEventListener("abort", abort);
  }
}
