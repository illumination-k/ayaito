import type { Edge, Middleware } from "./edge.ts";
import type { Context, Fn, Node } from "./node.ts";

/** The edge argument of then: optional when the output already fits the next input. */
type EdgeArg<A, B> = [A] extends [B] ? [edge?: Edge<A, B>] : [edge: Edge<A, B>];

/** A typed chain of nodes, built with then and closed with build into a node. */
export class Flow<I, O> {
  readonly name: string;
  private readonly fn: Fn<I, O>;

  private constructor(name: string, fn: Fn<I, O>) {
    this.name = name;
    this.fn = fn;
  }

  static start<I>(name: string): Flow<I, I> {
    return new Flow<I, I>(name, async (input) => input);
  }

  /** Runs node after the flow, through the edge's map and middleware. */
  // A Flow is built, never awaited; `then` reads as the next step.
  // oxlint-disable-next-line unicorn/no-thenable
  then<A, P>(node: Node<A, P>, ...[edge]: EdgeArg<O, A>): Flow<I, P> {
    const map = edge?.map as ((o: O, ctx: Context) => A | Promise<A>) | undefined;
    const run = wrap(node, edge?.use ?? []);
    return new Flow<I, P>(this.name, async (input, ctx) => {
      const out = await this.fn(input, ctx);
      return run(map ? await map(out, ctx) : (out as unknown as A), ctx);
    });
  }

  build(): Node<I, O> {
    return { name: this.name, run: this.fn };
  }
}

/** Records start, end and error around the middleware, which wraps the node. */
function wrap<I, O>(node: Node<I, O>, use: Middleware[]): Fn<I, O> {
  const inner = use.reduceRight<Fn<I, O>>((next, m) => m(node, next), node.run);
  return async (input, ctx) => {
    const started = Date.now();
    ctx.emit({ type: "start", node: node.name });
    try {
      const out = await inner(input, ctx);
      ctx.emit({ type: "end", node: node.name, ms: Date.now() - started });
      return out;
    } catch (error) {
      ctx.emit({ type: "error", node: node.name, error: String(error) });
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
    run: async (state, ctx) => ({ ...state, [key]: await node.run(state, ctx) }) as S & { [P in K]: O },
  };
}

type InputOf<T> = [T[keyof T]] extends [Node<infer I, unknown>] ? I : never;
type OutputsOf<T> = { [K in keyof T]: T[K] extends Node<never, infer O> ? O : never };

/**
 * Runs every node on the same input at once and returns their outputs under the same keys:
 * independent questions about one input, such as the five items of a checklist. Each node
 * runs through the middleware, and its start, end and error are recorded as in a flow.
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
    run: async (input, ctx) =>
      Object.fromEntries(
        await Promise.all(runs.map(async ([key, run]) => [key, await run(input as never, ctx)])),
      ) as OutputsOf<T>,
  };
}
