import type { Context, Node } from "./node.ts";
import { refine, type RefineResult, type Verdict } from "./refine.ts";
import type { Sent } from "./steer.ts";
import {
  type Access,
  type AgentRequest,
  type AgentResult,
  type AgentRuntime,
  brief,
  InterruptedError,
  OutputError,
  type OutputSchema,
  type Usage,
} from "./runtime.ts";

export interface AgentConfig<I, O> {
  /** The task, built from the node's input. */
  prompt: (input: I) => string;
  /** The output the agent must return. */
  output: OutputSchema<O>;
  system?: string;
  model?: string;
  cwd?: string;
  access?: Access;
}

/**
 * A node that runs an agent and returns its validated output. An answer that misses the
 * schema goes back to the same session, up to attempts calls in all (default 1); after
 * that the node throws.
 */
export function agentNode<I, O>(
  name: string,
  config: AgentConfig<I, O> & { attempts?: number },
  runtime: AgentRuntime,
): Node<I, O> {
  const { attempts, ...agent } = config;
  const node = refineNode(
    name,
    { ...agent, check: (result) => ({ ok: true, value: result.structured }), maxAttempts: attempts ?? 1 },
    runtime,
  );
  return {
    name,
    shape: { kind: "agent" },
    run: async (input, ctx) => {
      const result = await node.run(input, ctx);
      if (!result.ok) throw new Error(`${name}: ${result.feedback}`);
      return result.value;
    },
  };
}

/**
 * A node that refines: runs the agent, lets check judge the result (a quote the source does
 * not contain, a test that fails), and sends check's feedback back to the same session, up
 * to maxAttempts calls in all. Its output is the RefineResult, so a later node can record
 * what never passed.
 */
export function refineNode<I, O, T>(
  name: string,
  config: AgentConfig<I, O> & {
    check: (result: AgentResult<O>, input: I, attempt: number) => Verdict<T> | Promise<Verdict<T>>;
    maxAttempts: number;
  },
  runtime: AgentRuntime,
): Node<I, RefineResult<T>> {
  const { prompt, check, maxAttempts, ...request } = config;
  return {
    name,
    shape: { kind: "agent" },
    run: async (input, ctx) => {
      const { steer } = ctx;
      // The agent is reached by its node's name, inside forEach also as name#item, and by its session's id.
      let listener: ((sent: Sent) => void) | undefined;
      const offs: (() => void)[] = [];
      const listen = (address: string) => {
        if (steer && listener) offs.push(steer.listen(address, listener));
      };
      return refine({
        runtime: metered(runtime, name, ctx, listen),
        request: { ...request, cwd: request.cwd ?? ctx.cwd, prompt: prompt(input), node: name, signal: ctx.signal },
        check: async (result, attempt) => {
          const verdict = await check(result, input, attempt);
          if (!verdict.ok) ctx.emit({ type: "retry", node: name, attempt, error: verdict.feedback });
          return verdict;
        },
        maxAttempts,
        wrapUp: ctx.wrapUp,
        onWrapUp: () => ctx.emit({ type: "wrapUp", node: name }),
        steer:
          steer &&
          ((heard) => {
            listener = heard;
            listen(name);
            if (ctx.item !== undefined) listen(`${name}#${ctx.item}`);
            return () => {
              listener = undefined;
              for (const off of offs) off();
            };
          }),
        onSteer: (message) => ctx.emit({ type: "steer", node: name, message }),
        onStop: () => ctx.emit({ type: "wrapUp", node: name, stopped: true }),
      });
    },
  };
}

// An activity keeps this much of a message: events are for following the work, not for keeping it.
const SHOWN = 1000;

/** Records the usage of every call (an interrupted one too), a schema miss as a retry, the session and what the agent does. */
function metered(runtime: AgentRuntime, node: string, ctx: Context, onSession: (id: string) => void): AgentRuntime {
  let calls = 0;
  const sessions = new Set<string>();
  const usage = ({ costUsd, models }: Usage) => {
    if (costUsd !== undefined || models) ctx.emit({ type: "usage", node, usd: costUsd, models: models ?? {} });
  };
  return {
    name: runtime.name,
    close: () => runtime.close(),
    async run<T>(request: AgentRequest<T>) {
      calls++;
      try {
        const result = await runtime.run({
          ...request,
          onSession: (sessionId) => {
            if (sessions.has(sessionId)) return;
            sessions.add(sessionId);
            ctx.emit({ type: "session", node, sessionId });
            onSession(sessionId);
          },
          onActivity: ({ tool, text }) =>
            ctx.emit({ type: "activity", node, ...(tool !== undefined && { tool }), text: brief(text, SHOWN) }),
        });
        usage(result);
        return result;
      } catch (error) {
        if (error instanceof InterruptedError) usage(error.usage);
        if (error instanceof OutputError) {
          usage(error.usage);
          ctx.emit({ type: "retry", node, attempt: calls, error: error.issues });
        }
        throw error;
      }
    },
  };
}
