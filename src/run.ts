import type { Context, Node, RunEvent, Store, Tokens } from "./node.ts";

export interface RunResult<O> {
  output: O;
  costUsd: number;
  events: RunEvent[];
}

/**
 * Runs a node (usually a built flow) as runId. Running the same runId again resumes it:
 * nodes behind a checkpoint edge return their saved output.
 */
export async function run<I, O>(
  node: Node<I, O>,
  input: I,
  opts: { runId: string; store: Store; log?: (event: RunEvent) => void },
): Promise<RunResult<O>> {
  const events: RunEvent[] = [];
  let pending = Promise.resolve();
  const ctx: Context = {
    runId: opts.runId,
    store: opts.store,
    history: async () => {
      await pending;
      return opts.store.events(opts.runId);
    },
    emit: (e) => {
      const event = { ...e, at: new Date().toISOString() } as RunEvent;
      events.push(event);
      opts.log?.(event);
      // Events go to the store in order without making nodes wait for the disk.
      pending = pending.then(() => opts.store.append(opts.runId, event));
    },
  };
  try {
    const output = await node.run(input, ctx);
    return { output, costUsd: totalCost(events), events };
  } finally {
    await pending;
  }
}

export function totalCost(events: RunEvent[]): number {
  return events.reduce((sum, e) => (e.type === "usage" ? sum + e.usd : sum), 0);
}

/**
 * Tokens per node as a markdown table, summed over every call of the node (retries, loop
 * rounds, earlier attempts of a resumed run), for finding where to cut cost.
 */
export function usageReport(events: RunEvent[]): string {
  const rows = new Map<string, { calls: number; usd: number } & Tokens>();
  for (const e of events) {
    if (e.type !== "usage") continue;
    const r = rows.get(e.node) ?? { calls: 0, usd: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    r.calls++;
    r.usd += e.usd;
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
      `| ${node} | ${r.calls} | ${n(r.input)} | ${n(r.output)} | ${n(r.cacheRead)} | ${n(r.cacheCreation)} | ${r.usd.toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}
