import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  assign,
  checkpoint,
  checkpointBy,
  checkpointKey,
  effect,
  fnNode,
  Flow,
  FsStore,
  parallel,
  retry,
  run,
  Stop,
  until,
} from "../src/index.ts";

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

  it("checkpointBy skips a node whose key is the same though its input changed", async () => {
    const store = await tmpStore();
    let calls = 0;
    const review = fnNode("review", async (s: { round: number; topic: string }) => {
      calls++;
      return `${s.topic}!`;
    });
    const flow = Flow.start<{ round: number; topic: string }>("f")
      .then(review, { use: [checkpointBy((s: { topic: string }) => s.topic)] })
      .build();

    expect((await run(flow, { round: 1, topic: "a" }, { runId: "r", store })).output).toBe("a!");
    const { output, events } = await run(flow, { round: 2, topic: "a" }, { runId: "r", store });
    expect(output).toBe("a!");
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "skip" && e.node === "review")).toBe(true);
    expect(await store.get("r", checkpointKey("review", "a"))).toEqual({
      input: { round: 1, topic: "a" },
      output: "a!",
    });
  });

  it("checkpointBy runs the node again when a key outside the input changes", async () => {
    const store = await tmpStore();
    let calls = 0;
    let tree = "t1";
    const agent = fnNode("agent", async (n: number) => {
      calls++;
      return n + 1;
    });
    const flow = Flow.start<number>("f")
      .then(agent, { use: [checkpointBy(async (n: number) => ({ n, tree }))] })
      .build();

    await run(flow, 1, { runId: "r", store });
    await run(flow, 1, { runId: "r", store });
    expect(calls).toBe(1);
    tree = "t2";
    const { events } = await run(flow, 1, { runId: "r", store });
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "skip")).toBe(false);
  });

  it("checkpoint keys by the whole input as before", async () => {
    const store = await tmpStore();
    // An entry saved under the key checkpoint has always used resumes.
    expect(checkpointKey("double", { n: 2 })).toBe("double.363379742f80");
    await store.put("r", "double.363379742f80", { input: { n: 2 }, output: 99 });
    const double = fnNode("double", async (x: { n: number }) => x.n * 2);
    const flow = Flow.start<{ n: number }>("f")
      .then(double, { use: [checkpoint] })
      .build();

    expect((await run(flow, { n: 2 }, { runId: "r", store })).output).toBe(99);
    expect((await run(flow, { n: 3 }, { runId: "r", store })).output).toBe(6);
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

describe("parallel with failFast: false", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fails = (name: string, message: string) =>
    fnNode(name, async (): Promise<number> => {
      throw new Error(message);
    });
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AggregateError);
    return error as AggregateError;
  };

  it("lets a slow node finish when another fails, then fails with the failure and its key", async () => {
    let aborted = false;
    const events: string[] = [];
    const slow = fnNode("slow", async (n: number, ctx) => {
      await sleep(20);
      aborted = ctx.signal.aborted;
      return n;
    });
    const both = parallel("review", { slow, remote: fails("fails", "boom") }, { failFast: false });

    const error = await failure(
      run(both, 1, { runId: "r", store: await tmpStore(), log: (e) => events.push(`${e.type} ${e.node}`) }),
    );

    expect(aborted).toBe(false);
    expect(events).toContain("end slow");
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]).toMatchObject({ key: "remote", message: "boom" });
    expect(error.message).toContain("remote: boom");
  });

  it("collects every failure in the order of the nodes", async () => {
    const late = fnNode("late", async (): Promise<number> => {
      await sleep(10);
      throw new Error("late boom");
    });
    const all = parallel(
      "review",
      { a: late, ok: fnNode("ok", async (n: number) => n), b: fails("early", "early boom") },
      { failFast: false },
    );

    const error = await failure(run(all, 1, { runId: "r", store: await tmpStore() }));

    expect(error.errors.map((e: { key: string }) => e.key)).toEqual(["a", "b"]);
    expect(error.message).toContain("a: late boom");
    expect(error.message).toContain("b: early boom");
  });

  it("wraps what is not an Error, to carry the key", async () => {
    const text = fnNode("text", async (): Promise<number> => {
      // oxlint-disable-next-line typescript/only-throw-error
      throw "plain";
    });

    const error = await failure(
      run(parallel("p", { text }, { failFast: false }), 1, { runId: "r", store: await tmpStore() }),
    );

    expect(error.errors[0]).toMatchObject({ key: "text", message: "plain", cause: "plain" });
  });

  it("returns the same output as the default when every node succeeds", async () => {
    const nodes = { double: fnNode("double", async (n: number) => n * 2), text: fnNode("text", async (n: number) => `#${n}`) }; // prettier-ignore

    const kept = await run(parallel("both", nodes, { failFast: false }), 3, { runId: "a", store: await tmpStore() });
    const fast = await run(parallel("both", nodes), 3, { runId: "b", store: await tmpStore() });

    const typed: { double: number; text: string } | undefined = kept.output;
    expect(typed).toEqual({ double: 6, text: "#3" });
    expect(kept.output).toEqual(fast.output);
  });

  it("reruns only the failed node, the others return from their checkpoints", async () => {
    const store = await tmpStore();
    const ran: string[] = [];
    let down = true;
    const reviewer = (name: string) =>
      fnNode(name, async (n: number) => {
        await sleep(10);
        ran.push(name);
        return n;
      });
    const remote = fnNode("remote", async (n: number) => {
      if (down) throw new Error("unreachable");
      ran.push("remote");
      return n;
    });
    const review = parallel(
      "review",
      { a: reviewer("a"), remote, b: reviewer("b") },
      { failFast: false, use: [checkpoint] },
    );

    const error = await failure(run(review, 1, { runId: "r", store }));
    expect(error.errors.map((e: { key: string }) => e.key)).toEqual(["remote"]);
    expect(ran.toSorted()).toEqual(["a", "b"]);

    down = false;
    const { output, events } = await run(review, 1, { runId: "r", store });

    expect(output).toEqual({ a: 1, remote: 1, b: 1 });
    expect(ran.toSorted()).toEqual(["a", "b", "remote"]);
    expect(events.filter((e) => e.type === "skip").map((e) => e.node).toSorted()).toEqual(["a", "b"]); // prettier-ignore
  });

  it("aborts every node when the run is stopped, and fails with the reason", async () => {
    const abort = new AbortController();
    const aborted: string[] = [];
    const waits = (name: string) =>
      fnNode(name, async (_: number, ctx) => {
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
        aborted.push(name);
        throw ctx.signal.reason;
      });
    const both = parallel("both", { a: waits("a"), b: waits("b") }, { failFast: false });
    setTimeout(() => abort.abort(new Error("cancelled")), 10);

    const error = await run(both, 1, { runId: "r", store: await tmpStore(), signal: abort.signal }).catch(
      (e: unknown) => e,
    );

    expect(aborted.toSorted()).toEqual(["a", "b"]);
    expect(error).toMatchObject({ message: "cancelled" });
    expect(error).not.toBeInstanceOf(AggregateError);
  });

  it("ends the run early when a node throws Stop and none fails", async () => {
    const stops = fnNode("stops", async (): Promise<number> => {
      throw new Stop("nothing to do");
    });
    const ok = fnNode("ok", async (n: number) => n);

    const result = await run(parallel("p", { stops, ok }, { failFast: false }), 1, { runId: "r", store: await tmpStore() }); // prettier-ignore

    expect(result).toMatchObject({ status: "stopped", node: "stops", reason: "nothing to do" });
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

    const error = await run(parallel("both", { waits, fails }), 1, { runId: "r", store: await tmpStore() }).catch(
      (e: unknown) => e,
    );
    // The first failure as it was thrown, not wrapped.
    expect(error).toMatchObject({ message: "boom" });
    expect(error).not.toBeInstanceOf(AggregateError);
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
