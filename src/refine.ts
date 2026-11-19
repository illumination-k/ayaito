import { TimeoutError } from "./limits.ts";
import type { Context } from "./node.ts";
import type { Sent } from "./steer.ts";
import { type AgentRequest, type AgentResult, type AgentRuntime, InterruptedError, OutputError } from "./runtime.ts";

export type Verdict<T> = { ok: true; value: T } | { ok: false; feedback: string };

export type RefineResult<T> =
  | { ok: true; value: T; attempts: number; sessionId: string }
  | { ok: false; feedback: string; attempts: number; sessionId?: string };

/** How messages sent to an agent while it worked are put to it. */
export const steerPrompt = (messages: string[]): string =>
  `While you were working, this was sent to you:\n\n${messages.join("\n\n")}\n\nTake it into account and carry on with your task.`;

/** What an agent that is told to stop is asked. */
export const STOP_PROMPT = "Stop working now and give your final answer, based on what you have done so far.";

/** The reasons a turn is interrupted with to pass on a message, and to stop it. */
const STEERED = new Error("interrupted to pass on a message");
const STOPPED = new Error("told to stop");

interface Interruptions {
  /** The end of the work: time is up (timeout's wrapUp) or the agent was told to stop. */
  end?: { signal: AbortSignal; prompt: () => string; isStop: () => boolean };
  onWrapUp?: () => void;
  /** What was sent and not yet passed on, and how to interrupt the turn in progress for it. */
  inbox?: { messages: string[]; wake?: () => void };
  onSteer?: (message: string) => void;
}

/**
 * Asks the agent, then asks check whether the answer is good. If not, the same session gets
 * check's feedback as its next prompt, for at most maxAttempts calls. A schema miss counts
 * as one more bad answer. The result says whether an answer passed: giving up is reported,
 * not thrown, so that the caller decides what a failure means.
 *
 * With wrapUp (timeout's), the call running when time is up is interrupted and its session
 * asked for the answer, and no attempt follows the one that answers then.
 *
 * With steer, a message that comes during a call interrupts it, and its session gets the
 * message and goes on; that is no new attempt. One that comes between calls goes with the
 * next prompt. A stop ends the work as time being up does.
 */
export async function refine<O, T>({
  runtime,
  request,
  check,
  maxAttempts,
  wrapUp,
  onWrapUp,
  steer,
  onSteer,
  onStop,
}: {
  runtime: AgentRuntime;
  request: AgentRequest<O>;
  check: (result: AgentResult<O>, attempt: number) => Verdict<T> | Promise<Verdict<T>>;
  maxAttempts: number;
  wrapUp?: Context["wrapUp"];
  /** Called when a turn is interrupted to ask for the answer. */
  onWrapUp?: () => void;
  /** Listens for what is sent to the agent (Steer.listen for its node); returns how to end that. */
  steer?: (listener: (sent: Sent) => void) => () => void;
  /** Called with each message when it is passed on to the session. */
  onSteer?: (message: string) => void;
  /** Called when the agent is told to stop. */
  onStop?: () => void;
}): Promise<RefineResult<T>> {
  const inbox: NonNullable<Interruptions["inbox"]> = { messages: [] };
  const stop = new AbortController();
  const unlisten = steer?.((sent) => {
    if (sent.stop) {
      if (!stop.signal.aborted) onStop?.();
      stop.abort();
    } else {
      inbox.messages.push(sent.message);
      inbox.wake?.();
    }
  });
  const isTimeUp = () => wrapUp?.signal.aborted ?? false;
  const end: Interruptions["end"] = (wrapUp || steer) && {
    signal: wrapUp ? AbortSignal.any([wrapUp.signal, stop.signal]) : stop.signal,
    prompt: () => (wrapUp && isTimeUp() ? wrapUp.prompt : STOP_PROMPT),
    isStop: () => !isTimeUp(),
  };
  const on: Interruptions = { end, onWrapUp, inbox: steer && inbox, onSteer };
  let next = request;
  let feedback = "";
  let sessionId: string | undefined;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // The work ended before this call: ask for the answer along with the prompt.
      const late = end?.signal.aborted ? { ...next, prompt: `${next.prompt}\n\n${end.prompt()}` } : next;
      const outcome = await runOnce(runtime, late, on);
      sessionId = outcome.sessionId;
      const verdict = outcome instanceof OutputError ? undefined : await check(outcome, attempt);
      if (verdict?.ok) return { ok: true, value: verdict.value, attempts: attempt, sessionId };
      feedback = verdict ? verdict.feedback : (outcome as OutputError).message;
      if (end?.signal.aborted) return { ok: false, feedback, attempts: attempt, sessionId };
      next = { ...request, prompt: feedback, sessionId };
    }
    return { ok: false, feedback, attempts: maxAttempts, sessionId };
  } finally {
    unlisten?.();
  }
}

/**
 * One call, as far as check is concerned. When the work ends or a message comes during it, the
 * turn is interrupted and its session resumed: asked for its answer, or given the message.
 */
async function runOnce<O>(
  runtime: AgentRuntime,
  request: AgentRequest<O>,
  { end, onWrapUp, inbox, onSteer }: Interruptions,
): Promise<AgentResult<O> | OutputError> {
  const take = () => {
    if (!inbox?.messages.length) return undefined;
    const messages = inbox.messages.splice(0);
    for (const message of messages) onSteer?.(message);
    return steerPrompt(messages);
  };
  let current = request;
  for (;;) {
    // What was sent between calls goes with the prompt.
    const waiting = take();
    if (waiting !== undefined) current = { ...current, prompt: `${current.prompt}\n\n${waiting}` };
    // After the end, the call that answers is not interrupted again.
    if (!end || end.signal.aborted) return attempt(runtime, current);

    const interrupt = new AbortController();
    const ended = () =>
      interrupt.abort(end.isStop() ? STOPPED : new TimeoutError("time was up before the agent's session started"));
    end.signal.addEventListener("abort", ended, { once: true });
    if (inbox) inbox.wake = () => interrupt.abort(STEERED);
    try {
      const signal = current.signal ? AbortSignal.any([current.signal, interrupt.signal]) : interrupt.signal;
      return await attempt(runtime, { ...current, signal });
    } catch (error) {
      if (!interrupt.signal.aborted || request.signal?.aborted) throw error;
      const sessionId = error instanceof InterruptedError ? error.sessionId : undefined;
      // Without a session there is no work to answer from when time is up. A message or a stop
      // can still go with the prompt of a new call, whatever the runtime threw for the abort.
      if (sessionId === undefined && interrupt.signal.reason instanceof TimeoutError) throw error;
      const isEnd = end.signal.aborted;
      if (isEnd && !end.isStop()) onWrapUp?.();
      const said = [take(), isEnd ? end.prompt() : undefined].filter((part) => part !== undefined).join("\n\n");
      current =
        sessionId === undefined
          ? { ...current, prompt: `${current.prompt}\n\n${said}` }
          : { ...current, sessionId, prompt: said };
    } finally {
      end.signal.removeEventListener("abort", ended);
      if (inbox) inbox.wake = undefined;
    }
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
