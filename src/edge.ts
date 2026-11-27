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
  return named(`retry ×${opts.attempts}`, (node, next) => async (input, ctx) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await next(input, ctx);
      } catch (error) {
        // A cancelled run, a sibling that failed, a timeout or a spent budget: trying again cannot help.
        if (attempt >= opts.attempts || ctx.signal.aborted) throw error;
        ctx.emit({ type: "retry", node: node.name, attempt, error: String(error) });
        await new Promise((r) => setTimeout(r, (opts.delayMs ?? 0) * attempt));
      }
    }
  });
}

/**
 * Runs a side effect with the node's output, such as registering state for later nodes or
 * notifying someone, without changing the output.
 */
export function effect(fn: (output: unknown, ctx: Context, node: string) => void | Promise<void>): Middleware {
  return named("effect", (node, next) => async (input, ctx) => {
    const output = await next(input, ctx);
    await fn(output, ctx, node.name);
    return output;
  });
}

/**
 * Saves the output under the node name and a hash of key(input, ctx). Running the same run
 * again returns the saved output instead of running the node when the key is the same, so the
 * key decides what the output depends on: drop the fields the node does not read (a round
 * counter, a log of earlier rounds), or add what it reads outside its input (a hash of the
 * working tree). key may be async. The stored entry still holds the whole input, to show what
 * ran.
 */
export function checkpointBy<I = any>(key: (input: I, ctx: Context) => unknown): Middleware {
  return named("checkpoint", (node, next) => async (input, ctx) => {
    const k = checkpointKey(node.name, await key(input as never, ctx));
    const saved = (await ctx.store.get(ctx.runId, k)) as { output: never } | undefined;
    if (saved !== undefined) {
      ctx.emit({ type: "skip", node: node.name, reason: `checkpoint ${k}` });
      return saved.output;
    }
    const output = await next(input, ctx);
    await ctx.store.put(ctx.runId, k, { input, output });
    return output;
  });
}

/**
 * Saves the output under the node name and a hash of the input. Running the same run again
 * returns the saved output instead of running the node, so a failed run resumes where it
 * stopped. A node whose input changed (because an earlier node ran again) runs again.
 */
export const checkpoint: Middleware = checkpointBy((input) => input);

/**
 * Names a middleware for drawing (toMermaid). A middleware is otherwise drawn by its function
 * name, so one declared as `const audit: Middleware = ...` needs no name.
 */
export function named(name: string, m: Middleware): Middleware {
  return Object.defineProperty(m, "name", { value: name });
}

export function middlewareName(m: Middleware): string {
  return m.name || "middleware";
}

export function checkpointKey(name: string, input: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(input) ?? "undefined")
    .digest("hex");
  return `${name}.${hash.slice(0, 12)}`;
}
