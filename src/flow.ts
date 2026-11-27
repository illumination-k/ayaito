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

type OutputOf<N> = N extends Node<never, infer O> ? O : never;

/**
 * Runs the one node that route picks for the input: a review that passes goes on, one that
 * fails goes to a fix; an easy task goes to a cheaper model. The keys of cases must cover
 * every key route can return, and the output is any of theirs.
 */
export function branch<I, K extends string, C extends Record<K, Node<I, unknown>>>(
  name: string,
  route: (input: I, ctx: Context) => K | Promise<K>,
  cases: C,
): Node<I, OutputOf<C[K]>> {
  const runs = new Map(Object.entries<Node<I, unknown>>(cases).map(([key, node]) => [key, wrap(node, [])]));
  return {
    name,
    shape: { kind: "branch", cases: cases as Record<string, Node<never, unknown>> },
    run: async (input, ctx) => {
      const key = await route(input, ctx);
      const run = runs.get(key);
      if (!run) throw new Error(`${name}: no case for "${key}"`);
      return (await run(input, ctx)) as OutputOf<C[K]>;
    },
  };
}

/**
 * Runs node on each item of its input, at most concurrency at once (default all), and
 * returns their outputs in the order of the items: the tasks a planning agent listed, one
 * worker each. Each item runs through the middleware (a checkpoint keeps the items that
 * finished when another fails), and the first to fail aborts the others.
 *
 * With failFast: false, a failure aborts nothing and does not stop the queue: every item runs
 * to its end, and then, if any failed, an AggregateError is thrown whose errors are theirs, in
 * the order of the items, each with the index of its item as `item`. With checkpoint in use,
 * a rerun runs only the failed items. Cancelling the run still aborts every item.
 */
export function forEach<T, O>(
  name: string,
  node: Node<T, O>,
  opts: { concurrency?: number; failFast?: boolean; use?: Middleware[] } = {},
): Node<readonly T[], O[]> {
  const { concurrency } = opts;
  const failFast = opts.failFast ?? true;
  if (concurrency !== undefined && !(concurrency >= 1)) throw new Error(`${name}: concurrency must be at least 1`);
  const run = wrap(node, opts.use ?? []);
  return {
    name,
    shape: {
      kind: "forEach",
      body: node as Node<never, unknown>,
      concurrency,
      ...(!failFast && { failFast }),
      use: (opts.use ?? []).map(middlewareName),
    },
    run: async (items, ctx) => {
      const abort = new AbortController();
      const inner: Context = { ...ctx, signal: AbortSignal.any([ctx.signal, abort.signal]) };
      const results: PromiseSettledResult<O>[] = Array.from({ length: items.length });
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const i = next++;
          // Each item's events carry its index, and its agents can be reached by it.
          const item = ctx.item === undefined ? String(i) : `${ctx.item}.${i}`;
          const emit: Context["emit"] = (event) => inner.emit({ item, ...event });
          const output = run(items[i] as T, { ...inner, item, emit });
          if (failFast) results[i] = { status: "fulfilled", value: await output };
          else
            results[i] = await output.then(
              (value) => ({ status: "fulfilled", value }),
              (reason: unknown) => ({ status: "rejected", reason }),
            );
        }
      };
      const workers = Array.from({ length: Math.min(concurrency ?? items.length, items.length) }, worker);
      if (!failFast) {
        await Promise.all(workers);
        return settle(name, results, (i) => ({ item: i }), ctx.signal) as O[];
      }
      try {
        await Promise.all(workers);
        return results.map((r) => (r as PromiseFulfilledResult<O>).value);
      } catch (error) {
        abort.abort(error);
        throw error;
      }
    },
  };
}

type InputOf<T> = [T[keyof T]] extends [Node<infer I, unknown>] ? I : never;
type OutputsOf<T> = { [K in keyof T]: T[K] extends Node<never, infer O> ? O : never };

/**
 * Runs every node on the same input at once and returns their outputs under the same keys:
 * independent questions about one input, such as the five items of a checklist. Each node
 * runs through the middleware, and its start, end and error are recorded as in a flow. The
 * first node to fail (or stop) aborts the signal the others were given.
 *
 * With failFast: false, a failure aborts nothing: every node runs to its end, and then, if
 * any failed, an AggregateError is thrown whose errors are theirs, in the order of nodes,
 * each with the key of its node as `key`. With checkpoint in use, the nodes that succeeded
 * keep their outputs, and a rerun runs only the failed ones. Cancelling the run still aborts
 * every node.
 */
export function parallel<T extends Record<string, Node<never, unknown>>>(
  name: string,
  nodes: T,
  opts: { failFast?: boolean; use?: Middleware[] } = {},
): Node<InputOf<T>, OutputsOf<T>> {
  const failFast = opts.failFast ?? true;
  const runs = Object.entries(nodes as Record<string, Node<never, unknown>>).map(
    ([key, node]) => [key, wrap(node, opts.use ?? [])] as const,
  );
  return {
    name,
    shape: {
      kind: "parallel",
      branches: nodes,
      ...(!failFast && { failFast }),
      use: (opts.use ?? []).map(middlewareName),
    },
    run: async (input, ctx) => {
      if (!failFast) return (await allSettled(name, runs, input as never, ctx)) as OutputsOf<T>;
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

/** parallel without failFast: waits for every node, then fails with all the failures at once. */
async function allSettled(
  name: string,
  runs: (readonly [string, Fn<never, unknown>])[],
  input: never,
  ctx: Context,
): Promise<Record<string, unknown>> {
  const results = await Promise.allSettled(runs.map(([, run]) => run(input, ctx)));
  const values = settle(name, results, (i) => ({ key: (runs[i] as (typeof runs)[number])[0] }), ctx.signal);
  return Object.fromEntries(runs.map(([key], i) => [key, values[i]]));
}

/**
 * The outputs of members that all ran to their end (parallel or forEach without failFast),
 * or an AggregateError with every failure, in order, each with what `label` says it was.
 */
function settle<L extends { key: string } | { item: number }>(
  name: string,
  results: PromiseSettledResult<unknown>[],
  label: (i: number) => L,
  signal: AbortSignal,
): unknown[] {
  // The run was cancelled (a stop, a timeout, a spent budget): that is why the members failed.
  signal.throwIfAborted();
  const errors: (Error & L)[] = [];
  let stop: Stop | undefined;
  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") continue;
    if (result.reason instanceof Stop) stop ??= result.reason;
    else errors.push(labelled(result.reason, label(i)));
  }
  if (errors.length > 0) {
    const list = errors.map((e) => `${"key" in e ? e.key : e.item}: ${e.message}`).join("; ");
    throw new AggregateError(errors, `${name}: ${errors.length} of ${results.length} failed (${list})`);
  }
  // None failed, and one found nothing to do: the run ends early, as with failFast.
  if (stop) throw stop;
  return results.map((r) => (r as PromiseFulfilledResult<unknown>).value);
}

/** A member's error with its label; what is not an Error is wrapped in one. */
function labelled<L extends object>(error: unknown, label: L): Error & L {
  const e = error instanceof Error && Object.isExtensible(error) ? error : new Error(String(error), { cause: error });
  return Object.assign(e, label);
}
