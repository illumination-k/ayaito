import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  branch,
  budget,
  BudgetError,
  checkpoint,
  type Context,
  defineRuntime,
  fnNode,
  Flow,
  forEach,
  FsStore,
  refineNode,
  retry,
  run,
  timeout,
  TimeoutError,
} from "../src/index.ts";

const tmpStore = async () => new FsStore(await mkdtemp(join(tmpdir(), "ayaito-")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spend = (ctx: Context, usd: number) => ctx.emit({ type: "usage", node: "n", usd, models: {} });

describe("branch", () => {
  it("runs the case route picks", async () => {
    const sign = branch("sign", (n: number) => (n >= 0 ? "positive" : "negative"), {
      positive: fnNode("keep", async (n: number) => n),
      negative: fnNode("describe", async (n: number) => `minus ${-n}`),
    });
    const store = await tmpStore();

    const output: number | string | undefined = (await run(sign, -2, { runId: "a", store })).output;
    expect(output).toBe("minus 2");
    const { events } = await run(sign, 3, { runId: "b", store });
    expect(events.filter((e) => e.type === "end").map((e) => e.node)).toEqual(["keep"]);

    // @ts-expect-error -- every key route can return needs a case
    branch("sign", (n: number) => (n >= 0 ? "positive" : "negative"), {
      positive: fnNode("keep", async (n: number) => n),
    });
  });
});

describe("forEach", () => {
  it("keeps the order of the items and at most concurrency at once", async () => {
    let running = 0;
    let most = 0;
    const square = fnNode("square", async (n: number) => {
      most = Math.max(most, ++running);
      await sleep(n);
      running--;
      return n * n;
    });

    const { output } = await run(forEach("squares", square, { concurrency: 2 }), [30, 5, 10, 1], {
      runId: "r",
      store: await tmpStore(),
    });

    expect(output).toEqual([900, 25, 100, 1]);
    expect(most).toBe(2);
    expect((await run(forEach("none", square), [], { runId: "e", store: await tmpStore() })).output).toEqual([]);
  });

  it("aborts the other items when one fails, and resumes past the items that finished", async () => {
    const store = await tmpStore();
    const ran: number[] = [];
    let fail = true;
    const item = fnNode("item", async (n: number, ctx) => {
      if (n === 3 && fail) {
        await sleep(5);
        throw new Error("boom");
      }
      if (n === 4) {
        await new Promise((resolve, reject) => {
          if (!fail) return resolve(undefined);
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason as Error), { once: true });
        });
      }
      ran.push(n);
      return n;
    });
    const each = forEach("each", item, { use: [checkpoint] });

    await expect(run(each, [1, 2, 3, 4], { runId: "r", store })).rejects.toThrow("boom");
    expect(ran.toSorted((a, b) => a - b)).toEqual([1, 2]);
    fail = false;
    expect((await run(each, [1, 2, 3, 4], { runId: "r", store })).output).toEqual([1, 2, 3, 4]);
    expect(ran.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });
});

describe("budget", () => {
  it("aborts a node once it spends more than its budget", async () => {
    let calls = 0;
    const spender = fnNode("spender", async (_: number, ctx) => {
      for (let i = 0; i < 5; i++) {
        ctx.signal.throwIfAborted();
        calls++;
        spend(ctx, 0.4);
      }
      return 0;
    });
    const flow = Flow.start<number>("f")
      .then(spender, { use: [budget({ usd: 1 })] })
      .build();

    const error = await run(flow, 0, { runId: "r", store: await tmpStore() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetError);
    expect(error).toMatchObject({ message: "spender: over budget (spent $1.2 of $1)" });
    expect((error as BudgetError).spent.usd).toBeCloseTo(1.2);
    expect(calls).toBe(3);
  });

  it("stops the refining loop of an agent", async () => {
    let calls = 0;
    const runtime = defineRuntime({
      name: "fake",
      async run(request) {
        request.signal?.throwIfAborted();
        calls++;
        return { text: "", sessionId: "s", costUsd: 0.6 };
      },
    });
    const node = refineNode(
      "refine",
      { prompt: () => "", output: undefined as never, check: () => ({ ok: false, feedback: "again" }), maxAttempts: 5 },
      defineRuntime({ name: "plain", run: (r) => runtime.run({ ...r, output: undefined }) }),
    );
    const flow = Flow.start<number>("f")
      .then(node, { use: [budget({ usd: 1 })] })
      .build();

    await expect(run(flow, 0, { runId: "r", store: await tmpStore() })).rejects.toThrow(BudgetError);
    expect(calls).toBe(2);
  });

  it("limits a run, counting what earlier attempts spent", async () => {
    const store = await tmpStore();
    let fail = true;
    const flow = Flow.start<number>("f")
      .then(
        fnNode("first", async (n: number, ctx) => (spend(ctx, 0.6), n)),
        { use: [checkpoint] },
      )
      .then(
        fnNode("second", async (n: number, ctx) => {
          spend(ctx, 0.3);
          if (fail) throw new Error("boom");
          return n;
        }),
      )
      .then(fnNode("third", async (n: number) => ((third = true), n)))
      .build();
    let third = false;

    await expect(run(flow, 0, { runId: "r", store, budget: { usd: 1 } })).rejects.toThrow("boom");
    fail = false;
    // 0.6 + 0.3 before, and 0.3 more now: the node that went over finishes, the next one does not start.
    await expect(run(flow, 0, { runId: "r", store, budget: { usd: 1 } })).rejects.toThrow(BudgetError);
    expect(third).toBe(false);
    await expect(run(flow, 0, { runId: "r", store, budget: { usd: 0.5 } })).rejects.toThrow("over budget");
  });
});

describe("timeout", () => {
  it("aborts the node and throws without waiting for it", async () => {
    let aborted = false;
    const slow = fnNode("slow", async (n: number, ctx) => {
      ctx.signal.addEventListener("abort", () => (aborted = true));
      await sleep(1000);
      return n;
    });
    const flow = Flow.start<number>("f")
      .then(slow, { use: [timeout(20)] })
      .build();

    const started = Date.now();
    const error = await run(flow, 0, { runId: "r", store: await tmpStore() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ message: "slow: timed out after 20ms" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(aborted).toBe(true);
  });

  it("limits each attempt inside retry, and all of them around it", async () => {
    let attempts = 0;
    const slow = fnNode("slow", async (n: number) => {
      attempts++;
      await sleep(50);
      return n;
    });
    const store = await tmpStore();
    const each = Flow.start<number>("f")
      .then(slow, { use: [retry({ attempts: 3 }), timeout(10)] })
      .build();
    await expect(run(each, 0, { runId: "a", store })).rejects.toThrow(TimeoutError);
    expect(attempts).toBe(3);

    attempts = 0;
    const all = Flow.start<number>("f")
      .then(slow, { use: [timeout(10), retry({ attempts: 3 })] })
      .build();
    await expect(run(all, 0, { runId: "b", store })).rejects.toThrow(TimeoutError);
    await sleep(60);
    expect(attempts).toBe(1);
  });
});
