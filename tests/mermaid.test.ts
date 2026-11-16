import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { agentNode, assign, checkpoint, fnNode, Flow, parallel, retry, toMermaid, until } from "../src/index.ts";

const noQuery = async function* () {};

describe("toMermaid", () => {
  it("draws flows, agents, parallel nodes, loops and edges", () => {
    const prepare = fnNode("prepare", async (s: { text: string }) => s);
    const topic = agentNode("select topic", { prompt: () => "", output: z.string() }, noQuery);
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

  it("draws a node without a shape as code and escapes quotes", () => {
    expect(toMermaid({ name: 'say "hi"', run: async () => 1 })).toContain('n0["say #quot;hi#quot;"]');
  });
});
