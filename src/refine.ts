import { TimeoutError } from "./limits.ts";
import type { Context } from "./node.ts";
import { type AgentRequest, type AgentResult, type AgentRuntime, InterruptedError, OutputError } from "./runtime.ts";

export type Verdict<T> = { ok: true; value: T } | { ok: false; feedback: string };

export type RefineResult<T> =
  | { ok: true; value: T; attempts: number; sessionId: string }
  | { ok: false; feedback: string; attempts: number; sessionId?: string };

/**
 * Asks the agent, then asks check whether the answer is good. If not, the same session gets
 * check's feedback as its next prompt, for at most maxAttempts calls. A schema miss counts
 * as one more bad answer. The result says whether an answer passed: giving up is reported,
 * not thrown, so that the caller decides what a failure means.
 *
 * With wrapUp (timeout's), the call running when time is up is interrupted and its session
 * asked for the answer, and no attempt follows the one that answers then.
 */
export async function refine<O, T>({
  runtime,
  request,
  check,
  maxAttempts,
  wrapUp,
  onWrapUp,
}: {
  runtime: AgentRuntime;
  request: AgentRequest<O>;
  check: (result: AgentResult<O>, attempt: number) => Verdict<T> | Promise<Verdict<T>>;
  maxAttempts: number;
  wrapUp?: Context["wrapUp"];
  /** Called when a turn is interrupted to ask for the answer. */
  onWrapUp?: () => void;
}): Promise<RefineResult<T>> {
  let next = request;
  let feedback = "";
  let sessionId: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Time was up before this call: ask for the answer along with the prompt.
    const late = wrapUp?.signal.aborted ? { ...next, prompt: `${next.prompt}\n\n${wrapUp.prompt}` } : next;
    const outcome = await runOnce(runtime, late, wrapUp, onWrapUp);
    sessionId = outcome.sessionId;
    const verdict = outcome instanceof OutputError ? undefined : await check(outcome, attempt);
    if (verdict?.ok) return { ok: true, value: verdict.value, attempts: attempt, sessionId };
    feedback = verdict ? verdict.feedback : (outcome as OutputError).message;
    if (wrapUp?.signal.aborted) return { ok: false, feedback, attempts: attempt, sessionId };
    next = { ...request, prompt: feedback, sessionId };
  }
  return { ok: false, feedback, attempts: maxAttempts, sessionId };
}

/** One call; when time is up during it, the interrupted session is asked for its answer instead. */
async function runOnce<O>(
  runtime: AgentRuntime,
  request: AgentRequest<O>,
  wrapUp: Context["wrapUp"],
  onWrapUp: (() => void) | undefined,
): Promise<AgentResult<O> | OutputError> {
  if (!wrapUp || wrapUp.signal.aborted) return attempt(runtime, request);
  const interrupt = new AbortController();
  const timeUp = () => interrupt.abort(new TimeoutError("time was up before the agent's session started"));
  wrapUp.signal.addEventListener("abort", timeUp, { once: true });
  try {
    const signal = request.signal ? AbortSignal.any([request.signal, interrupt.signal]) : interrupt.signal;
    return await attempt(runtime, { ...request, signal });
  } catch (error) {
    if (!(error instanceof InterruptedError) || !interrupt.signal.aborted || request.signal?.aborted) throw error;
    onWrapUp?.();
    return attempt(runtime, { ...request, sessionId: error.sessionId, prompt: wrapUp.prompt });
  } finally {
    wrapUp.signal.removeEventListener("abort", timeUp);
  }
}

async function attempt<O>(runtime: AgentRuntime, request: AgentRequest<O>): Promise<AgentResult<O> | OutputError> {
  try {
    return await runtime.run(request);
  } catch (error) {
    if (error instanceof OutputError) return error;
    throw error;
  }
}
