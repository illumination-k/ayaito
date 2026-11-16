import { middlewareName, type Edge, type Middleware } from "./edge.ts";
import { type Context, type Fn, type Node, type Step, Stop } from "./node.ts";

/** The edge argument of then: optional when the output already fits the next input. */
type EdgeArg<A, B> = [A] extends [B] ? [edge?: Edge<A, B>] : [edge: Edge<A, B>];

/** A typed chain of nodes, built with then and closed with build into a node. */
export class Flow<I, O> {
  readonly name: string;
  private readonly fn: Fn<I, O>;
  private readonly steps: Step[];

  private constructor(name: string, fn: Fn<I, O>, steps: Step[]) {
    this.name = name;
    this.fn = fn;
    this.steps = steps;
  }

  static start<I>(name: string): Flow<I, I> {
    return new Flow<I, I>(name, async (input) => input, []);
  }

  /** Runs node after the flow, through the edge's map and middleware. */
  // A Flow is built, never awaited; `then` reads as the next step.
  // oxlint-disable-next-line unicorn/no-thenable
  then<A, P>(node: Node<A, P>, ...[edge]: EdgeArg<O, A>): Flow<I, P> {
    const map = edge?.map as ((o: O, ctx: Context) => A | Promise<A>) | undefined;
    const use = edge?.use ?? [];
    const run = wrap(node, use);
    const step: Step = { node: node as Node<never, unknown>, map: map !== undefined, use: use.map(middlewareName) };
    return new Flow<I, P>(
      this.name,
      async (input, ctx) => {
        const out = await this.fn(input, ctx);
        return run(map ? await map(out, ctx) : (out as unknown as A), ctx);
      },
      [...this.steps, step],
    );
  }

  build(): Node<I, O> {
    return { name: this.name, run: this.fn, shape: { kind: "flow", steps: this.steps } };
  }
}

/**
 * Records start, end and error (or the stop) around the middleware, which wraps the node.
 * A cancelled run starts no more nodes.
 */
function wrap<I, O>(node: Node<I, O>, use: Middleware[]): Fn<I, O> {
  const inner = use.reduceRight<Fn<I, O>>((next, m) => m(node, next), node.run);
  return async (input, ctx) => {
    ctx.signal.throwIfAborted();
    const started = Date.now();
    ctx.emit({ type: "start", node: node.name });
    try {
      const out = await inner(input, ctx);
      ctx.emit({ type: "end", node: node.name, ms: Date.now() - started });
      return out;
    } catch (error) {
      if (!(error instanceof Stop)) {
        ctx.emit({ type: "error", node: node.name, error: String(error) });
      } else if (error.node === undefined) {
        // The innermost node threw it; the flows around it pass it on.
        error.node = node.name;
        ctx.emit({ type: "stop", node: node.name, reason: error.message });
      }
      throw error;
    }
  };
}

/**
 * Runs body on its own output until done says so, at most max times: loops such as
 * "check, and fix what the check found". Throws when it does not converge.
 */
export function until<A>(name: string, body: Node<A, A>, done: (a: A) => boolean, max: number): Node<A, A> {
  const run = wrap(body, []);
  return {
    name,
    shape: { kind: "until", body: body as Node<never, unknown>, max },
    run: async (input, ctx) => {
      let a = input;
      for (let i = 0; i < max; i++) {
        if (done(a)) return a;
        a = await run(a, ctx);
      }
      if (done(a)) return a;
      throw new Error(`${name}: not done after ${max} runs of ${body.name}`);
    },
  };
}

/**
 * Runs node on the state and adds its output to the state under key, so that later nodes
 * still see what earlier ones produced. Keeps the node's name.
 */
export function assign<S extends object, K extends string, O>(key: K, node: Node<S, O>): Node<S, S & { [P in K]: O }> {
  return {
    name: node.name,
    shape: { kind: "assign", key, node: node as Node<never, unknown> },
    run: async (state, ctx) => ({ ...state, [key]: await node.run(state, ctx) }) as S & { [P in K]: O },
  };
}

type InputOf<T> = [T[keyof T]] extends [Node<infer I, unknown>] ? I : never;
type OutputsOf<T> = { [K in keyof T]: T[K] extends Node<never, infer O> ? O : never };

/**
 * Runs every node on the same input at once and returns their outputs under the same keys:
 * independent questions about one input, such as the five items of a checklist. Each node
 * runs through the middleware, and its start, end and error are recorded as in a flow. The
 * first node to fail (or stop) aborts the signal the others were given.
 */
export function parallel<T extends Record<string, Node<never, unknown>>>(
  name: string,
  nodes: T,
  opts: { use?: Middleware[] } = {},
): Node<InputOf<T>, OutputsOf<T>> {
  const runs = Object.entries(nodes as Record<string, Node<never, unknown>>).map(
    ([key, node]) => [key, wrap(node, opts.use ?? [])] as const,
  );
  return {
    name,
    shape: { kind: "parallel", branches: nodes, use: (opts.use ?? []).map(middlewareName) },
    run: async (input, ctx) => {
      const abort = new AbortController();
      const inner: Context = { ...ctx, signal: AbortSignal.any([ctx.signal, abort.signal]) };
      try {
        return Object.fromEntries(
          await Promise.all(runs.map(async ([key, run]) => [key, await run(input as never, inner)])),
        ) as OutputsOf<T>;
      } catch (error) {
        abort.abort(error);
        throw error;
      }
    },
  };
}
