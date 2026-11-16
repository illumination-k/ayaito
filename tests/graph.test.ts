import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  agentNode,
  assign,
  checkpoint,
  effect,
  fnNode,
  Flow,
  FsStore,
  parallel,
  retry,
  run,
  until,
  usageReport,
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

    const typed: { double: number; text: string } = output;
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

describe("agentNode", () => {
  const result = (fields: Record<string, unknown>) => ({
    type: "result",
    total_cost_usd: 0.5,
    errors: [],
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 10,
        outputTokens: 2000,
        cacheReadInputTokens: 30000,
        cacheCreationInputTokens: 4000,
      },
    },
    ...fields,
  });
  const fakeQuery = (message: Record<string, unknown>, seen: Options[] = []) =>
    async function* (params: { prompt: string; options?: Options }): AsyncGenerator<SDKMessage> {
      seen.push({ ...params.options, systemPrompt: params.prompt });
      yield message as unknown as SDKMessage;
    };

  it("returns the validated structured output and reports tokens per node", async () => {
    const seen: Options[] = [];
    const store = await tmpStore();
    const node = agentNode(
      "pick",
      { prompt: (n: number) => `pick ${n}`, output: z.object({ topic: z.string() }), options: { cwd: "/x" } },
      fakeQuery(result({ subtype: "success", structured_output: { topic: "婚活" } }), seen),
    );
    const { output, costUsd } = await run(node, 3, { runId: "r", store });
    await run(node, 4, { runId: "r", store });

    expect(output).toEqual({ topic: "婚活" });
    expect(costUsd).toBe(0.5);
    expect(usageReport(await store.events("r"))).toContain("| pick | 2 | 20 | 4,000 | 60,000 | 8,000 | 1.00 |");
    expect(seen[0]?.systemPrompt).toBe("pick 3");
    expect(seen[0]?.cwd).toBe("/x");
    expect(seen[0]?.outputFormat?.schema).toMatchObject({ type: "object", required: ["topic"] });
    expect(seen[0]?.outputFormat?.schema).not.toHaveProperty("$schema");
  });

  it("throws when the agent fails or returns invalid output", async () => {
    const out = z.object({ topic: z.string() });
    const store = await tmpStore();
    const failed = agentNode(
      "a",
      { prompt: () => "", output: out },
      fakeQuery(result({ subtype: "error_max_budget_usd", errors: ["over budget"] })),
    );
    await expect(run(failed, 0, { runId: "r", store })).rejects.toThrow("error_max_budget_usd: over budget");
    const apiError = agentNode(
      "e",
      { prompt: () => "", output: out },
      fakeQuery(result({ subtype: "success", is_error: true, result: "API Error: 400 invalid schema" })),
    );
    await expect(run(apiError, 0, { runId: "r", store })).rejects.toThrow("e: API Error: 400 invalid schema");
    const invalid = agentNode(
      "b",
      { prompt: () => "", output: out },
      fakeQuery(result({ subtype: "success", structured_output: { topic: 1 } })),
    );
    await expect(run(invalid, 0, { runId: "r", store })).rejects.toThrow();
  });

  it("sends review problems back, and returns the output as it is once repairs run out", async () => {
    const out = z.object({ quote: z.string() });
    const seen: string[] = [];
    const query = async function* (params: { prompt: string; options?: Options }): AsyncGenerator<SDKMessage> {
      seen.push(params.prompt);
      yield result({
        subtype: "success",
        session_id: "s1",
        structured_output: { quote: "invented" },
      }) as unknown as SDKMessage;
    };
    const node = agentNode(
      "cite",
      {
        prompt: () => "cite",
        output: out,
        repairs: 2,
        review: (o) => (o.quote === "invented" ? [`not in the paper: ${o.quote}`] : []),
      },
      query,
    );

    const { output } = await run(node, 0, { runId: "r", store: await tmpStore() });

    expect(output).toEqual({ quote: "invented" });
    expect(seen).toHaveLength(3);
    expect(seen[1]).toContain("- not in the paper: invented");
  });

  it("sends the validation errors back in the same session when repairs are allowed", async () => {
    const out = z.object({ topic: z.string().min(1) });
    const answers = [{ topic: "" }, { topic: "婚活" }];
    const seen: { prompt: string; resume?: string }[] = [];
    const query = async function* (params: { prompt: string; options?: Options }): AsyncGenerator<SDKMessage> {
      seen.push({ prompt: params.prompt, resume: params.options?.resume });
      const structured_output = answers[seen.length - 1];
      yield result({ subtype: "success", session_id: "s1", structured_output }) as unknown as SDKMessage;
    };

    const { output, events } = await run(
      agentNode("pick", { prompt: () => "pick", output: out, repairs: 1 }, query),
      0,
      {
        runId: "r",
        store: await tmpStore(),
      },
    );

    expect(output).toEqual({ topic: "婚活" });
    expect(seen[1]?.resume).toBe("s1");
    expect(seen[1]?.prompt).toContain("- topic:");
    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(2);
  });
});
