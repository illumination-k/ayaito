import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  agentNode,
  assign,
  branch,
  budget,
  checkpoint,
  checkpointBy,
  defineRuntime,
  fnNode,
  Flow,
  forEach,
  named,
  parallel,
  retry,
  timeout,
  toMermaid,
  until,
  worktree,
} from "../src/index.ts";

const noRuntime = defineRuntime({ name: "none", run: async () => ({ text: "", sessionId: "" }) });

describe("toMermaid", () => {
  it("draws flows, agents, parallel nodes, loops and edges", () => {
    const prepare = fnNode("prepare", async (s: { text: string }) => s);
    const topic = agentNode("select topic", { prompt: () => "", output: z.string() }, noRuntime);
    const fix = fnNode("fix", async (n: number) => n + 1);
    const checks = parallel(
      "checks",
      { length: fnNode("length", async (s: string) => s.length), words: fnNode("count words", async (s: string) => s) },
      { use: [checkpoint] },
    );
    const flow = Flow.start<{ text: string }>("weekly")
      .then(prepare)
      .then(assign("topic", topic), { use: [checkpoint, retry({ attempts: 3 })] })
      .then(checks, { map: (s) => s.topic })
      .then(
        until("fix until green", fix, (n) => n > 2, 5),
        { map: (c) => c.length },
      )
      .build();

    expect(toMermaid(flow)).toBe(
      [
        "flowchart TD",
        "  in((input))",
        '  subgraph s0["weekly"]',
        '    n1["prepare"]',
        '    n2(["select topic → topic"]):::agent',
        '    subgraph s3["checks"]',
        '      n4["length"]',
        '      n5["words: count words"]',
        "    end",
        '    subgraph s6["fix until green (at most 5)"]',
        '      c7{"done?"}',
        '      n8["fix"]',
        "    end",
        "  end",
        "  out((output))",
        "  in --> n1",
        '  n1 -->|"checkpoint, retry ×3"| n2',
        '  n2 -->|"map, checkpoint"| n4',
        '  n2 -->|"map, checkpoint"| n5',
        '  n4 -->|"map"| c7',
        '  n5 -->|"map"| c7',
        '  c7 -->|"no"| n8',
        "  n8 --> c7",
        '  c7 -->|"yes"| out',
        "  classDef agent fill:#ede9fe,stroke:#7c3aed",
      ].join("\n"),
    );
  });

  it("draws checkpointBy as checkpoint unless named", () => {
    const flow = Flow.start<number>("f")
      .then(
        fnNode("a", async (n: number) => n),
        { use: [checkpointBy((n) => n)] },
      )
      .then(
        fnNode("b", async (n: number) => n),
        {
          use: [
            named(
              "checkpoint by topic",
              checkpointBy((n) => n),
            ),
          ],
        },
      )
      .build();

    expect(toMermaid(flow)).toContain('|"checkpoint"|');
    expect(toMermaid(flow)).toContain('|"checkpoint by topic"|');
  });

  it("draws a nested flow as a subgraph and keeps the edge into it", () => {
    const inner = Flow.start<number>("inner")
      .then(fnNode("a", async (n: number) => n))
      .build();
    const flow = Flow.start<number>("outer")
      .then(inner, { use: [checkpoint] })
      .build();

    expect(toMermaid(flow)).toContain('  in -->|"checkpoint"| n2');
    expect(toMermaid(flow)).toContain('subgraph s1["inner"]');
  });

  it("draws branch as a choice, forEach as a subgraph and a worktree on its node", () => {
    const plan = agentNode("plan", { prompt: () => "", output: z.array(z.string()) }, noRuntime);
    const fix = agentNode("fix", { prompt: (task: string) => task, output: z.string() }, noRuntime);
    const flow = Flow.start<string>("ship")
      .then(plan, { use: [budget({ usd: 2 })] })
      .then(forEach("fix each", worktree(fix), { concurrency: 3, use: [checkpoint, timeout(600_000)] }))
      .then(
        branch("all fixed?", (fixes: readonly unknown[]) => (fixes.length > 0 ? "yes" : "no"), {
          yes: fnNode("open PR", async () => "pr"),
          no: fnNode("report", async () => "none"),
        }),
      )
      .build();

    expect(toMermaid(flow)).toBe(
      [
        "flowchart TD",
        "  in((input))",
        '  subgraph s0["ship"]',
        '    n1(["plan"]):::agent',
        '    subgraph s2["fix each (each item, 3 at a time)"]',
        '      n3(["fix (worktree)"]):::agent',
        "    end",
        '    c4{"all fixed?"}',
        '    n5["open PR"]',
        '    n6["report"]',
        "  end",
        "  out((output))",
        '  in -->|"budget $2"| n1',
        '  n1 -->|"checkpoint, timeout 10m"| n3',
        "  n3 --> c4",
        '  c4 -->|"yes"| n5',
        '  c4 -->|"no"| n6',
        "  n5 --> out",
        "  n6 --> out",
        "  classDef agent fill:#ede9fe,stroke:#7c3aed",
      ].join("\n"),
    );
  });

  it("labels a parallel node whose nodes all finish when one fails", () => {
    const nodes = { a: fnNode("a", async (n: number) => n) };

    expect(toMermaid(parallel("review", nodes, { failFast: false }))).toContain('subgraph s0["review (all finish)"]');
    expect(toMermaid(parallel("review", nodes))).toContain('subgraph s0["review"]');
  });

  it("labels a forEach whose items all finish when one fails", () => {
    const item = fnNode("item", async (n: number) => n);

    expect(toMermaid(forEach("each", item, { failFast: false }))).toContain(
      'subgraph s0["each (each item, all finish)"]',
    );
    expect(toMermaid(forEach("each", item, { concurrency: 2, failFast: false }))).toContain('subgraph s0["each (each item, 2 at a time, all finish)"]'); // prettier-ignore
    expect(toMermaid(forEach("each", item))).toContain('subgraph s0["each (each item)"]');
  });

  it("draws a node without a shape as code and escapes quotes", () => {
    expect(toMermaid({ name: 'say "hi"', run: async () => 1 })).toContain('n0["say #quot;hi#quot;"]');
  });
});
