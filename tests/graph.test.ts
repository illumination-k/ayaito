import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { assign, checkpoint, effect, fnNode, Flow, FsStore, parallel, retry, run, Stop, until } from "../src/index.ts";

const tmpStore = async () => new FsStore(await mkdtemp(join(tmpdir(), "ayaito-")));

describe("Flow", () => {
  it("chains nodes through edges that map types", async () => {
    const length = fnNode("length", async (s: string) => s.length);
    const double = fnNode("double", async (n: number) => n * 2);
    const flow = Flow.start<string>("f")
      .then(length)
      .then(double)
      .then(
        fnNode("show", async (s: string) => `=${s}`),
        { map: (n) => String(n) },
      )
      .build();

    Flow.start<string>("g")
      .then(length)
      // @ts-expect-error -- number does not fit string without a map
      .then(fnNode("show", async (s: string) => s));

    const { output, events } = await run(flow, "abc", { runId: "r", store: await tmpStore() });
    expect(output).toBe("=6");
    expect(events.filter((e) => e.type === "end").map((e) => e.node)).toEqual(["length", "double", "show"]);
  });

  it("resumes a failed run from its checkpoints", async () => {
    const store = await tmpStore();
    let calls = 0;
    let fail = true;
    const counted = fnNode("counted", async (n: number) => {
      calls++;
      return n + 1;
    });
    const flaky = fnNode("flaky", async (n: number) => {
      if (fail) throw new Error("boom");
      return n * 10;
    });
    const flow = Flow.start<number>("f")
      .then(counted, { use: [checkpoint] })
      .then(flaky, { use: [checkpoint] })
      .build();

    await expect(run(flow, 1, { runId: "r", store })).rejects.toThrow("boom");
    fail = false;
    const { output, events } = await run(flow, 1, { runId: "r", store });
    expect(output).toBe(20);
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "skip" && e.node === "counted")).toBe(true);

    expect(await store.invalidate("r", "counted")).toBe(1);
    await run(flow, 1, { runId: "r", store });
    expect(calls).toBe(2);

    const log = await readFile(join(store.dir, "r", "events.jsonl"), "utf8");
    expect(log).toContain('"type":"error"');
  });

  it("retries and runs side effects", async () => {
    let attempts = 0;
    const seen: unknown[] = [];
    const flaky = fnNode("flaky", async (n: number) => {
      if (++attempts < 3) throw new Error("again");
      return n;
    });
    const flow = Flow.start<number>("f")
      .then(flaky, { use: [effect((out) => void seen.push(out)), retry({ attempts: 3 })] })
      .build();

    const { output, events } = await run(flow, 7, { runId: "r", store: await tmpStore() });
    expect(output).toBe(7);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    expect(seen).toEqual([7]);
  });

  it("adds a node's output to the state", async () => {
    const flow = Flow.start<{ n: number }>("f")
      .then(
        assign(
          "twice",
          fnNode("twice", async (s: { n: number }) => s.n * 2),
        ),
      )
      .then(fnNode("sum", async (s: { n: number; twice: number }) => s.n + s.twice))
      .build();
    expect((await run(flow, { n: 2 }, { runId: "r", store: await tmpStore() })).output).toBe(6);
  });

  it("loops until done, and fails when it does not converge", async () => {
    const inc = fnNode("inc", async (n: number) => n + 1);
    const store = await tmpStore();
    expect(
      (
        await run(
          until("loop", inc, (n) => n >= 3, 5),
          0,
          { runId: "a", store },
        )
      ).output,
    ).toBe(3);
    await expect(
      run(
        until("loop", inc, (n) => n >= 10, 2),
        0,
        { runId: "b", store },
      ),
    ).rejects.toThrow("not done after 2");
  });
});

describe("parallel", () => {
  it("runs every node on the input at once and keys their outputs", async () => {
    let running = 0;
    let most = 0;
    const slow = <O>(name: string, f: (n: number) => O) =>
      fnNode(name, async (n: number) => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return f(n);
      });
    const both = parallel("both", { double: slow("double", (n) => n * 2), text: slow("text", (n) => `#${n}`) });

    const { output, events } = await run(both, 3, { runId: "r", store: await tmpStore() });

    const typed: { double: number; text: string } | undefined = output;
    expect(typed).toEqual({ double: 6, text: "#3" });
    expect(most).toBe(2);
    expect(
      events
        .filter((e) => e.type === "end")
        .map((e) => e.node)
        .sort(),
    ).toEqual(["double", "text"]);
  });
});

describe("Stop and cancellation", () => {
  it("ends the run early as a success when a node throws Stop", async () => {
    let after = false;
    const flow = Flow.start<number>("f")
      .then(
        fnNode("find", async (n: number): Promise<number> => {
          throw new Stop(`nothing to do for ${n}`);
        }),
      )
      .then(fnNode("after", async (n: number) => ((after = true), n)))
      .build();

    const result = await run(flow, 1, { runId: "r", store: await tmpStore() });

    expect(result).toMatchObject({ status: "stopped", node: "find", reason: "nothing to do for 1" });
    expect(after).toBe(false);
    expect(result.events.filter((e) => e.type === "stop")).toHaveLength(1);
    expect(result.events.some((e) => e.type === "error")).toBe(false);
  });

  it("aborts the other nodes of parallel when one fails", async () => {
    let aborted = false;
    const waits = fnNode("waits", async (_: number, ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
      aborted = true;
      return 0;
    });
    const fails = fnNode("fails", async (): Promise<number> => {
      throw new Error("boom");
    });

    await expect(run(parallel("both", { waits, fails }), 1, { runId: "r", store: await tmpStore() })).rejects.toThrow(
      "boom",
    );
    expect(aborted).toBe(true);
  });

  it("starts no node once the run is cancelled", async () => {
    const abort = new AbortController();
    const flow = Flow.start<number>("f")
      .then(fnNode("first", async (n: number) => (abort.abort(new Error("cancelled")), n)))
      .then(fnNode("second", async (n: number) => n))
      .build();

    await expect(run(flow, 1, { runId: "r", store: await tmpStore(), signal: abort.signal })).rejects.toThrow(
      "cancelled",
    );
  });
});
