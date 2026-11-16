import { type AgentRequest, type AgentResult, type AgentRuntime, OutputError } from "./runtime.ts";

export type Verdict<T> = { ok: true; value: T } | { ok: false; feedback: string };

export type RefineResult<T> =
  | { ok: true; value: T; attempts: number; sessionId: string }
  | { ok: false; feedback: string; attempts: number; sessionId?: string };

/**
 * Asks the agent, then asks check whether the answer is good. If not, the same session gets
 * check's feedback as its next prompt, for at most maxAttempts calls. A schema miss counts
 * as one more bad answer. The result says whether an answer passed: giving up is reported,
 * not thrown, so that the caller decides what a failure means.
 */
export async function refine<O, T>({
  runtime,
  request,
  check,
  maxAttempts,
}: {
  runtime: AgentRuntime;
  request: AgentRequest<O>;
  check: (result: AgentResult<O>, attempt: number) => Verdict<T> | Promise<Verdict<T>>;
  maxAttempts: number;
}): Promise<RefineResult<T>> {
  let next = request;
  let feedback = "";
  let sessionId: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = await runOnce(runtime, next);
    sessionId = outcome.sessionId;
    const verdict = outcome instanceof OutputError ? undefined : await check(outcome, attempt);
    if (verdict?.ok) return { ok: true, value: verdict.value, attempts: attempt, sessionId };
    feedback = verdict ? verdict.feedback : (outcome as OutputError).message;
    next = { ...request, prompt: feedback, sessionId };
  }
  return { ok: false, feedback, attempts: maxAttempts, sessionId };
}

async function runOnce<O>(runtime: AgentRuntime, request: AgentRequest<O>): Promise<AgentResult<O> | OutputError> {
  try {
    return await runtime.run(request);
  } catch (error) {
    if (error instanceof OutputError) return error;
    throw error;
  }
}
