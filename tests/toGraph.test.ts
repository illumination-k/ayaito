import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  agentNode,
  assign,
  branch,
  checkpoint,
  defineRuntime,
  fnNode,
  Flow,
  forEach,
  graphSchema,
  FsStore,
  parallel,
  run,
  toGraph,
  toMermaid,
  until,
  worktree,
} from "../src/index.ts";

const noRuntime = defineRuntime({ name: "none", run: async () => ({ text: "", sessionId: "" }) });

describe("toGraph", () => {
  it("describes nodes, their groups and the edges as plain data", () => {
    const topic = agentNode("select topic", { prompt: () => "", output: z.string() }, noRuntime);
    const flow = Flow.start<{ text: string }>("weekly")
      .then(assign("topic", topic), { use: [checkpoint] })
      .then(parallel("checks", { length: fnNode("count", async (s: string) => s.length) }), { map: (s) => s.topic })
      .build();

    expect(toGraph(flow)).toEqual({
      nodes: [
        { id: "in", kind: "input", label: "input" },
        { id: "s0", kind: "flow", name: "weekly", label: "weekly" },
        { id: "n1", kind: "agent", name: "select topic", label: "select topic", assign: "topic", parent: "s0" },
        { id: "s2", kind: "parallel", name: "checks", label: "checks", parent: "s0" },
        { id: "n3", kind: "fn", name: "count", label: "count", key: "length", parent: "s2" },
        { id: "out", kind: "output", label: "output" },
      ],
      edges: [
        { from: "in", to: "n1", use: ["checkpoint"] },
        { from: "n1", to: "n3", map: true },
        { from: "n3", to: "out" },
      ],
    });
  });

  it("describes choices, loops, forEach and worktrees", () => {
    const fix = agentNode("fix", { prompt: (task: string) => task, output: z.string() }, noRuntime);
    const flow = Flow.start<string[]>("ship")
      .then(forEach("fix each", worktree(fix), { concurrency: 3 }))
      .then(
        branch("fixed?", (fixes: readonly unknown[]) => (fixes.length > 0 ? "yes" : "no"), {
          yes: fnNode("open PR", async () => 1),
          no: fnNode("report", async () => 0),
        }),
      )
      .then(
        until(
          "retry",
          fnNode("wait", async (n: number) => n),
          (n) => n > 2,
          5,
        ),
      )
      .build();
    const { nodes, edges } = toGraph(flow);

    expect(nodes).toContainEqual({ id: "s1", kind: "forEach", name: "fix each", label: "fix each", concurrency: 3, parent: "s0" }); // prettier-ignore
    expect(nodes).toContainEqual({ id: "n2", kind: "agent", name: "fix", label: "fix", worktree: true, parent: "s1" });
    expect(nodes).toContainEqual({ id: "s6", kind: "until", name: "retry", label: "retry", max: 5, parent: "s0" });
    expect(nodes).toContainEqual({ id: "c7", kind: "choice", label: "done?", parent: "s6" });
    expect(edges).toContainEqual({ from: "c3", to: "n4", when: "yes" });
    expect(edges).toContainEqual({ from: "c7", to: "out", when: "yes" });
  });

  it("survives JSON, and toMermaid draws the graph as it draws the node", () => {
    const flow = Flow.start<number>("f")
      .then(fnNode("a", async (n: number) => n))
      .build();
    const graph = JSON.parse(JSON.stringify(toGraph(flow)));

    expect(graph).toEqual(toGraph(flow));
    expect(toMermaid(graph)).toBe(toMermaid(flow));
  });

  it("marks a parallel node whose nodes all finish, and only that one", () => {
    const nodes = { a: fnNode("a", async (n: number) => n) };
    const group = (opts?: { failFast?: boolean }) => toGraph(parallel("review", nodes, opts)).nodes[1];

    expect(group({ failFast: false })).toEqual({ id: "s0", kind: "parallel", name: "review", label: "review", failFast: false }); // prettier-ignore
    expect(group({ failFast: true })).toEqual({ id: "s0", kind: "parallel", name: "review", label: "review" });
    expect(group()).toEqual({ id: "s0", kind: "parallel", name: "review", label: "review" });
  });

  it("marks a forEach whose items all finish, and only that one", () => {
    const item = fnNode("item", async (n: number) => n);
    const group = (opts?: { failFast?: boolean }) => toGraph(forEach("each", item, opts)).nodes[1];

    expect(group({ failFast: false })).toEqual({ id: "s0", kind: "forEach", name: "each", label: "each", failFast: false }); // prettier-ignore
    expect(group({ failFast: true })).toEqual({ id: "s0", kind: "forEach", name: "each", label: "each" });
    expect(group()).toEqual({ id: "s0", kind: "forEach", name: "each", label: "each" });
  });

  it("has a JSON Schema that names every kind and property toGraph uses", () => {
    const fix = agentNode("fix", { prompt: (task: string) => task, output: z.string() }, noRuntime);
    const flow = Flow.start<string[]>("ship")
      .then(forEach("each", worktree(fix), { concurrency: 2, failFast: false, use: [checkpoint] }))
      .then(
        parallel(
          "checks",
          {
            n: assign(
              "count",
              fnNode("count", async (s: { length: number }) => s.length),
            ),
          },
          { failFast: false },
        ),
        {
          map: (fixes) => ({ length: fixes.length }),
        },
      )
      .then(
        branch("any?", (s: { n: unknown }) => (s.n ? "yes" : "no"), {
          yes: until(
            "loop",
            fnNode("wait", async (s: { n: unknown }) => s),
            () => true,
            2,
          ),
          no: fnNode("report", async (s: { n: unknown }) => s),
        }),
      )
      .build();
    const { nodes, edges } = toGraph(flow);
    const { node, edge } = graphSchema.$defs;

    expect(new Set(nodes.map((n) => n.kind))).toEqual(new Set(node.properties.kind.enum));
    expect(new Set(nodes.flatMap((n) => Object.keys(n)))).toEqual(new Set(Object.keys(node.properties)));
    expect(new Set(edges.flatMap((e) => Object.keys(e)))).toEqual(new Set(Object.keys(edge.properties)));
    expect(JSON.parse(JSON.stringify(graphSchema))).toEqual(graphSchema);
  });

  it("is saved with a run as graph.json, beside the events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ayaito-"));
    const flow = Flow.start<number>("f")
      .then(fnNode("a", async (n: number) => n))
      .build();
    await run(flow, 1, { runId: "r", store: new FsStore(dir) });

    expect(JSON.parse(await readFile(join(dir, "r", "graph.json"), "utf8"))).toEqual(toGraph(flow));
  });
});
