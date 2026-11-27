import { type Budget, limitSpend, spentIn } from "./limits.ts";
import { toGraph } from "./graph.ts";
import type { Steer } from "./steer.ts";
import { type Context, type Node, type RunEvent, Stop, type Store, type Tokens } from "./node.ts";

/** "stopped" when a node threw Stop: the run ended early, as a success. */
export type RunResult<O> = { costUsd: number; events: RunEvent[] } & (
  | { status: "done"; output: O }
  | { status: "stopped"; node: string; reason: string; output?: undefined }
);

/**
 * Runs a node (usually a built flow) as runId. Running the same runId again resumes it:
 * nodes behind a checkpoint edge return their saved output. Aborting signal cancels the run.
 * A budget aborts the run with BudgetError once its agents spend more, counting what earlier
 * attempts of the run spent. cwd is the directory agent nodes without one of their own run in.
 * steer (see steering) carries messages to agents while they work.
 */
export async function run<I, O>(
  node: Node<I, O>,
  input: I,
  opts: {
    runId: string;
    store: Store;
    log?: (event: RunEvent) => void;
    signal?: AbortSignal;
    budget?: Budget;
    cwd?: string;
    steer?: Steer;
  },
): Promise<RunResult<O>> {
  const events: RunEvent[] = [];
  let pending = Promise.resolve();
  const base: Context = {
    runId: opts.runId,
    cwd: opts.cwd,
    steer: opts.steer,
    store: opts.store,
    signal: opts.signal ?? new AbortController().signal,
    history: async () => {
      await pending;
      return opts.store.events(opts.runId);
    },
    emit: (e) => {
      const event = { ...e, at: new Date().toISOString() };
      events.push(event);
      opts.log?.(event);
      // Events go to the store in order without making nodes wait for the disk.
      pending = pending.then(() => opts.store.append(opts.runId, event));
    },
  };
  // The graph is saved with the run, so that a viewer can lay events.jsonl over it.
  await opts.store.put(opts.runId, "graph", toGraph(node));
  const limited = opts.budget && limitSpend(base, opts.budget, node.name, spentIn(await opts.store.events(opts.runId)));
  const ctx = limited?.ctx ?? base;
  try {
    ctx.signal.throwIfAborted();
    const output = await node.run(input, ctx);
    return { status: "done", output, costUsd: totalCost(events), events };
  } catch (error) {
    if (!(error instanceof Stop)) throw limited?.exceeded() ?? error;
    const stopped = { node: error.node ?? node.name, reason: error.message };
    return { status: "stopped", ...stopped, costUsd: totalCost(events), events };
  } finally {
    await pending;
  }
}

/** The cost the runtimes reported; calls of a runtime that reports none (codex) add nothing. */
export function totalCost(events: RunEvent[]): number {
  return events.reduce((sum, e) => (e.type === "usage" ? sum + (e.usd ?? 0) : sum), 0);
}

/**
 * Tokens per node as a markdown table, summed over every call of the node (retries, loop
 * rounds, earlier attempts of a resumed run), for finding where to cut cost.
 */
export function usageReport(events: RunEvent[]): string {
  const rows = new Map<string, { calls: number; usd?: number } & Tokens>();
  for (const e of events) {
    if (e.type !== "usage") continue;
    const r = rows.get(e.node) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    r.calls++;
    if (e.usd !== undefined) r.usd = (r.usd ?? 0) + e.usd;
    for (const t of Object.values(e.models)) {
      r.input += t.input;
      r.output += t.output;
      r.cacheRead += t.cacheRead;
      r.cacheCreation += t.cacheCreation;
    }
    rows.set(e.node, r);
  }
  const n = (x: number) => x.toLocaleString("en-US");
  const lines = [
    "| node | calls | input | output | cache read | cache write | est. USD |",
    "| ---- | ----: | ----: | -----: | ---------: | ----------: | -------: |",
  ];
  for (const [node, r] of rows) {
    lines.push(
      `| ${node} | ${r.calls} | ${n(r.input)} | ${n(r.output)} | ${n(r.cacheRead)} | ${n(r.cacheCreation)} | ${r.usd?.toFixed(2) ?? "-"} |`,
    );
  }
  return lines.join("\n");
}
