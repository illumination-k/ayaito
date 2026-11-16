import { createHash } from "node:crypto";

import type { Context, Fn, Node } from "./node.ts";

/**
 * Wraps how the next node runs: the middle layer where an edge keeps state, retries, and
 * side effects, without the node knowing.
 */
export type Middleware = <I, O>(node: Node<I, O>, next: Fn<I, O>) => Fn<I, O>;

type EdgeMap<A, B> = (a: A, ctx: Context) => B | Promise<B>;

/**
 * The connection into a node: a Fn that turns the previous output into the node's input,
 * and the middleware around the node. map is required only when the types differ.
 */
export type Edge<A, B> = { use?: Middleware[] } & ([A] extends [B] ? { map?: EdgeMap<A, B> } : { map: EdgeMap<A, B> });

/** Runs the node again when it throws, up to attempts times in all, waiting delayMs × attempt. */
export function retry(opts: { attempts: number; delayMs?: number }): Middleware {
  return (node, next) => async (input, ctx) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await next(input, ctx);
      } catch (error) {
        if (attempt >= opts.attempts) throw error;
        ctx.emit({ type: "retry", node: node.name, attempt, error: String(error) });
        await new Promise((r) => setTimeout(r, (opts.delayMs ?? 0) * attempt));
      }
    }
  };
}

/**
 * Runs a side effect with the node's output, such as registering state for later nodes or
 * notifying someone, without changing the output.
 */
export function effect(fn: (output: unknown, ctx: Context, node: string) => void | Promise<void>): Middleware {
  return (node, next) => async (input, ctx) => {
    const output = await next(input, ctx);
    await fn(output, ctx, node.name);
    return output;
  };
}

/**
 * Saves the output under the node name and a hash of the input. Running the same run again
 * returns the saved output instead of running the node, so a failed run resumes where it
 * stopped. A node whose input changed (because an earlier node ran again) runs again.
 */
export const checkpoint: Middleware = (node, next) => async (input, ctx) => {
  const key = checkpointKey(node.name, input);
  const saved = (await ctx.store.get(ctx.runId, key)) as { output: never } | undefined;
  if (saved !== undefined) {
    ctx.emit({ type: "skip", node: node.name, reason: `checkpoint ${key}` });
    return saved.output;
  }
  const output = await next(input, ctx);
  await ctx.store.put(ctx.runId, key, { input, output });
  return output;
};

export function checkpointKey(name: string, input: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(input) ?? "undefined")
    .digest("hex");
  return `${name}.${hash.slice(0, 12)}`;
}
