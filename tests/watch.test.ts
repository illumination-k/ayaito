import { describe, expect, it } from "vite-plus/test";

import {
  agentNode,
  assign,
  branch,
  checkpoint,
  defineRuntime,
  fnNode,
  Flow,
  forEach,
  formatRun,
  parallel,
  type RunEvent,
  toGraph,
} from "../src/index.ts";

const runtime = defineRuntime({ name: "fake", run: async () => ({ text: "ok", sessionId: "s" }) });
const flow = Flow.start<number>("f")
  .then(
    fnNode("prepare", async (n: number) => ({ n })),
    { use: [checkpoint] },
  )
  .then(assign("topic", agentNode("pick", { prompt: () => "p" }, runtime)))
  .then(
    parallel("both", {
      a: fnNode("a", async (s: { n: number }) => s.n),
      b: fnNode("b", async (s: { n: number }) => s.n),
    }),
    { map: () => ({ n: 1 }) },
  )
  .then(
    branch("route", (s: { a: number }) => (s.a > 0 ? "big" : "small"), {
      big: fnNode("ship", async (s: { a: number }) => [s.a]),
      small: fnNode("drop", async (s: { a: number }) => [s.a]),
    }),
  )
  .then(
    forEach(
      "each",
      fnNode("item", async (n: number) => n),
      { concurrency: 1 },
    ),
  )
  .build();
const graph = toGraph(flow);

const t0 = Date.parse("2026-01-02T03:00:00.000Z");
// Omit, for each kind of event.
type New = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at"> : never) : never;
/** Events a second apart, from t0. */
const at = (events: New[]): RunEvent[] => events.map((e, i) => ({ ...e, at: new Date(t0 + i * 1000).toISOString() }));

const tokens = { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 };
const started = at([
  { type: "start", node: "prepare" },
  { type: "skip", node: "prepare", reason: "checkpoint prepare.abc" },
  { type: "end", node: "prepare", ms: 3 },
  { type: "start", node: "pick" },
  { type: "retry", node: "pick", attempt: 1, error: "bad" },
  { type: "usage", node: "pick", usd: 0.25, models: { m: tokens } },
  { type: "activity", node: "pick", tool: "Read", text: "a.ts\n  again" },
]);

describe("formatRun", () => {
  it("draws the graph with every node waiting before the run records anything", () => {
    expect(formatRun(graph, [])).toBe(
      [
        "0/7 steps",
        "○ f",
        "  ○ prepare  checkpoint",
        "  ○ pick  → topic",
        "  ○ both  parallel",
        "    ○ a",
        "    ○ b",
        "  ○ ◇ route",
        "  ○ big: ship",
        "  ○ small: drop",
        "  ○ each  each item, 1 at a time",
        "    ○ item",
      ].join("\n"),
    );
  });

  it("shows a running agent with its attempt, its time so far, its cost and the last thing it did", () => {
    const lines = formatRun(graph, started, t0 + 93_000).split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "1/7 steps · $0.250",
      "● f",
      "  – prepare  checkpoint · 3ms",
      "  ● pick  → topic · attempt 2 · 2m · $0.250",
      "      Read a.ts again",
    ]);
    expect(lines[5]).toBe("  ○ both  parallel");
  });

  it("shows what was sent to an agent and what code logged, in place of what it did before", () => {
    const steered = [...started, ...at([{ type: "steer", node: "pick", message: "only open ones" }])];
    expect(formatRun(graph, steered).split("\n")[4]).toBe("      ← only open ones");
    const stopped = [...started, ...at([{ type: "wrapUp", node: "pick", stopped: true }])];
    expect(formatRun(graph, stopped).split("\n")[4]).toBe("      ← stop");
    const timeUp = [...started, ...at([{ type: "wrapUp", node: "pick" }])];
    expect(formatRun(graph, timeUp).split("\n")[4]).toBe("      Read a.ts again");
    const logged = at([
      { type: "start", node: "each" },
      { type: "start", node: "item", item: "2" },
      { type: "log", node: "item", item: "2", text: "half way" },
    ]);
    expect(
      formatRun(graph, logged, t0 + 2000)
        .split("\n")
        .slice(-3),
    ).toEqual(["  ● each  each item, 1 at a time · 2.0s", "    ● item  1.0s", "        #2 half way"]);
  });

  it("shows the case a branch did not take, the items of a forEach and the error of a node that failed", () => {
    const events = at([
      ...started.map(({ at: _, ...e }) => e),
      { type: "end", node: "pick", ms: 61_000 },
      { type: "start", node: "both" },
      { type: "start", node: "a" },
      { type: "start", node: "b" },
      { type: "end", node: "a", ms: 1500 },
      { type: "end", node: "b", ms: 20 },
      { type: "end", node: "both", ms: 1500 },
      { type: "start", node: "route" },
      { type: "start", node: "ship" },
      { type: "end", node: "ship", ms: 1 },
      { type: "end", node: "route", ms: 1 },
      { type: "start", node: "each" },
      { type: "start", node: "item", item: "0" },
      { type: "end", node: "item", item: "0", ms: 5 },
      { type: "start", node: "item", item: "1" },
      { type: "error", node: "item", item: "1", error: "Error: boom\nmore" },
      { type: "error", node: "each", error: "Error: boom\nmore" },
    ]);
    expect(formatRun(graph, events)).toBe(
      [
        // The case that was not taken is no step of this run.
        "5/6 steps · $0.250",
        "✗ f",
        "  – prepare  checkpoint · 3ms",
        "  ✓ pick  → topic · 1m · $0.250",
        "  ✓ both  parallel · 1.5s",
        "    ✓ a  1.5s",
        "    ✓ b  20ms",
        "  ✓ ◇ route  1ms",
        "  ✓ big: ship  1ms",
        "  – small: drop  not taken",
        "  ✗ each  each item, 1 at a time",
        "      Error: boom more",
        "    ✗ item  ×2 · 5ms",
        "        Error: boom more",
      ].join("\n"),
    );
  });

  it("shows what was running as stopped once a node stops the run, and a group that is done", () => {
    const stopped = at([
      { type: "start", node: "prepare" },
      { type: "end", node: "prepare", ms: 1 },
      { type: "start", node: "pick" },
      { type: "start", node: "both" },
      { type: "stop", node: "pick", reason: "nothing to do" },
    ]);
    expect(formatRun(graph, stopped).split("\n").slice(1, 5)).toEqual([
      "■ f",
      "  ✓ prepare  checkpoint · 1ms",
      "  ■ pick  → topic",
      "  ■ both  parallel",
    ]);

    const two = Flow.start<number>("g")
      .then(fnNode("one", async (n: number) => n))
      .then(fnNode("two", async (n: number) => n))
      .build();
    const events = at([
      { type: "start", node: "one" },
      { type: "end", node: "one", ms: 1 },
      { type: "start", node: "two" },
      { type: "end", node: "two", ms: 2000 },
    ]);
    expect(formatRun(toGraph(two), events)).toBe("2/2 steps\n✓ g\n  ✓ one  1ms\n  ✓ two  2.0s");
    // Between two nodes the run still goes on.
    expect(formatRun(toGraph(two), events.slice(0, 2)).split("\n")[1]).toBe("● g");
  });
});
