import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  agentNode,
  branch,
  checkpoint,
  defineRuntime,
  fnNode,
  Flow,
  forEach,
  FsStore,
  parallel,
  retry,
  type RunEvent,
  Stop,
} from "../src/index.ts";
import { runTraced, tracing } from "../src/otel.ts";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer("test");
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const tmpStore = async () => new FsStore(await mkdtemp(join(tmpdir(), "ayaito-")));
const spans = () => exporter.getFinishedSpans();
const span = (name: string, item?: string) => {
  const found = spans().find((s) => s.name === name && s.attributes["ayaito.item"] === item);
  if (!found) throw new Error(`no span ${name}${item === undefined ? "" : `#${item}`}`);
  return found;
};
const parentOf = (name: string, item?: string) => {
  const id = span(name, item).parentSpanContext?.spanId;
  return spans().find((s) => s.spanContext().spanId === id)?.name;
};

const models = { opus: { input: 10, output: 5, cacheRead: 100, cacheCreation: 20 } };
const agent = defineRuntime({
  name: "fake",
  run: async ({ prompt, onSession, onActivity }) => {
    onSession?.("s1");
    onActivity?.({ tool: "Read", text: "notes.md" });
    onActivity?.({ text: "thinking" });
    return { text: "", sessionId: "s1", structured: { n: prompt.length }, costUsd: 0.5, models };
  },
});
const count = agentNode("count", { prompt: (s: string) => s, output: z.object({ n: z.number() }) }, agent);

beforeEach(() => exporter.reset());

describe("runTraced", () => {
  it("makes the run a span and each node a span inside the node it runs in", async () => {
    const inner = Flow.start<string>("inner").then(count).build();
    const flow = Flow.start<string>("outer")
      .then(fnNode("trim", async (s: string) => s.trim()))
      .then(inner)
      .build();

    const result = await runTraced(flow, " abc ", { runId: "r1", store: await tmpStore(), tracer });

    expect(result.output).toEqual({ n: 3 });
    expect(parentOf("trim")).toBe("invoke_workflow outer");
    expect(parentOf("inner")).toBe("invoke_workflow outer");
    expect(parentOf("invoke_agent count")).toBe("inner");
    expect(span("invoke_workflow outer").attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_workflow",
      "gen_ai.workflow.name": "outer",
      "ayaito.run.id": "r1",
      "ayaito.run.status": "done",
      "ayaito.usage.cost_usd": 0.5,
    });
    expect(span("trim").attributes).toMatchObject({ "ayaito.node": "trim", "ayaito.node.kind": "fn" });
  });

  it("times a span by its events", async () => {
    const wait = fnNode("wait", async () => new Promise((r) => setTimeout(r, 30)));
    const events: RunEvent[] = [];
    await runTraced(Flow.start<void>("f").then(wait).build(), undefined, {
      runId: "r",
      store: await tmpStore(),
      tracer,
      log: (e) => events.push(e),
    });

    const [start, end] = events;
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    const ms = ([s, ns]: [number, number]) => s * 1000 + ns / 1e6;
    expect(ms(span("wait").startTime)).toBe(Date.parse(start.at));
    expect(ms(span("wait").endTime)).toBe(Date.parse(end.at));
  });

  it("records an agent by the GenAI conventions, and its usage on the run too", async () => {
    await runTraced(Flow.start<string>("f").then(count).build(), "ab", { runId: "r", store: await tmpStore(), tracer });

    const usage = {
      "gen_ai.usage.input_tokens": 130,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cache_read.input_tokens": 100,
      "gen_ai.usage.cache_creation.input_tokens": 20,
      "gen_ai.response.model": "opus",
      "ayaito.usage.models": ["opus"],
      "ayaito.usage.cost_usd": 0.5,
    };
    expect(span("invoke_agent count").attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "count",
      "gen_ai.conversation.id": "s1",
      "ayaito.node.kind": "agent",
      ...usage,
    });
    expect(span("invoke_workflow f").attributes).toMatchObject(usage);
  });

  it("leaves what agents say and read out of the trace unless content is set", async () => {
    const flow = Flow.start<string>("f").then(count).build();
    await runTraced(flow, "ab", { runId: "r", store: await tmpStore(), tracer });
    expect(span("invoke_agent count").events.map((e) => [e.name, e.attributes])).toEqual([
      ["prompt", { runtime: "fake" }],
      ["tool", { "gen_ai.tool.name": "Read" }],
      ["answer", {}],
    ]);

    exporter.reset();
    await runTraced(flow, "ab", { runId: "r", store: await tmpStore(), tracer, content: true });
    expect(span("invoke_agent count").events.map((e) => [e.name, e.attributes])).toEqual([
      ["prompt", { runtime: "fake", text: "ab" }],
      ["tool", { "gen_ai.tool.name": "Read", input: "notes.md" }],
      ["message", { text: "thinking" }],
      ["answer", { text: '{"n":2}' }],
    ]);
  });

  it("adds up the usage of every call of a node", async () => {
    const twice = fnNode("twice", async (_: void, ctx) => {
      ctx.emit({ type: "usage", node: "twice", usd: 1, models: { a: models.opus } });
      ctx.emit({ type: "usage", node: "twice", models: { b: models.opus } });
    });
    await runTraced(Flow.start<void>("f").then(twice).build(), undefined, {
      runId: "r",
      store: await tmpStore(),
      tracer,
    });

    const { attributes } = span("twice");
    expect(attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 260,
      "gen_ai.usage.output_tokens": 10,
      "ayaito.usage.models": ["a", "b"],
      "ayaito.usage.cost_usd": 1,
    });
    expect(attributes["gen_ai.response.model"]).toBeUndefined();
  });

  it("keeps the members of parallel apart, and the items of forEach by their index", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const both = parallel("both", {
      a: fnNode("a", async (_: number[]) => sleep(10)),
      b: fnNode("b", async (_: number[]) => sleep(1)),
    });
    const each = forEach(
      "each",
      Flow.start<number>("item")
        .then(fnNode("double", async (n: number) => (await sleep(5 - n), n * 2)))
        .build(),
    );
    const flow = Flow.start<number[]>("f")
      .then(both)
      .then(each, { map: () => [1, 2] })
      .build();

    await runTraced(flow, [], { runId: "r", store: await tmpStore(), tracer });

    expect(parentOf("a")).toBe("both");
    expect(parentOf("b")).toBe("both");
    expect(parentOf("item", "0")).toBe("each");
    for (const item of ["0", "1"]) {
      const parent = span("item", item).spanContext().spanId;
      expect(span("double", item).parentSpanContext?.spanId).toBe(parent);
    }
  });

  it("puts the case of a branch inside the branch", async () => {
    const sign = branch("sign", (n: number) => (n >= 0 ? "plus" : "minus"), {
      plus: fnNode("keep", async (n: number) => n),
      minus: fnNode("negate", async (n: number) => -n),
    });
    await runTraced(Flow.start<number>("f").then(sign).build(), -1, { runId: "r", store: await tmpStore(), tracer });

    expect(parentOf("negate")).toBe("sign");
    expect(spans().some((s) => s.name === "keep")).toBe(false);
  });

  it("marks the node that failed and the run as errors, and keeps retries and skips as events", async () => {
    let calls = 0;
    const flaky = fnNode("flaky", async () => {
      if (++calls === 1) throw new Error("once");
      return 1;
    });
    const boom = fnNode("boom", async () => {
      throw new Error("no");
    });
    const flow = Flow.start<void>("f")
      .then(flaky, { use: [checkpoint, retry({ attempts: 2 })] })
      .then(boom)
      .build();
    const store = await tmpStore();

    await expect(runTraced(flow, undefined, { runId: "r", store, tracer })).rejects.toThrow("no");

    expect(span("flaky").events.map((e) => [e.name, e.attributes])).toEqual([
      ["retry", { attempt: 1, error: "Error: once" }],
    ]);
    expect(span("flaky").status.code).toBe(SpanStatusCode.UNSET);
    expect(span("boom").status).toEqual({ code: SpanStatusCode.ERROR, message: "Error: no" });
    expect(span("boom").events[0].attributes).toEqual({ "exception.message": "Error: no" });
    const root = span("invoke_workflow f");
    expect(root.status).toEqual({ code: SpanStatusCode.ERROR, message: "Error: no" });
    expect(root.events[0].name).toBe("exception");

    exporter.reset();
    await expect(runTraced(flow, undefined, { runId: "r", store, tracer })).rejects.toThrow("no");
    expect(span("flaky").events.map((e) => e.name)).toEqual(["skip"]);
  });

  it("ends the spans a Stop passed through, and the run as stopped", async () => {
    const inner = Flow.start<void>("inner")
      .then(
        fnNode("check", async () => {
          throw new Stop("nothing to do");
        }),
      )
      .build();
    const result = await runTraced(Flow.start<void>("f").then(inner).build(), undefined, {
      runId: "r",
      store: await tmpStore(),
      tracer,
    });

    expect(result.status).toBe("stopped");
    expect(span("check").events.map((e) => [e.name, e.attributes])).toEqual([["stop", { reason: "nothing to do" }]]);
    expect(span("inner").status.code).toBe(SpanStatusCode.UNSET);
    const root = span("invoke_workflow f");
    expect(root.attributes["ayaito.run.status"]).toBe("stopped");
    expect(root.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("puts the run inside the span that is active when it starts", async () => {
    const store = await tmpStore();
    const flow = Flow.start<void>("f")
      .then(fnNode("a", async () => {}))
      .build();
    await tracer.startActiveSpan("job", async (job) => {
      await runTraced(flow, undefined, { runId: "r", store, tracer });
      job.end();
    });

    expect(parentOf("invoke_workflow f")).toBe("job");
    expect(parentOf("a")).toBe("invoke_workflow f");
  });
});

describe("tracing", () => {
  it("traces a saved run from its events, with the times they have", () => {
    const flow = Flow.start<void>("f")
      .then(fnNode("a", async () => {}))
      .build();
    const traced = tracing(flow, { runId: "old", tracer });
    traced.log({ type: "start", node: "a", at: "2026-01-02T03:04:05.000Z" });
    traced.log({ type: "wrapUp", node: "a", at: "2026-01-02T03:04:06.000Z", stopped: true });
    traced.log({ type: "steer", node: "a", at: "2026-01-02T03:04:06.500Z", message: "hurry" });
    traced.log({ type: "end", node: "a", at: "2026-01-02T03:04:07.000Z", ms: 2000 });
    // An event for a node that is not running goes to the run.
    traced.log({ type: "skip", node: "gone", at: "2026-01-02T03:04:08.000Z", reason: "why" });
    traced.log({ type: "end", node: "gone", at: "2026-01-02T03:04:08.000Z", ms: 0 });
    traced.end();

    const a = span("a");
    expect(a.startTime[0]).toBe(Date.parse("2026-01-02T03:04:05.000Z") / 1000);
    expect(a.endTime[0]).toBe(Date.parse("2026-01-02T03:04:07.000Z") / 1000);
    expect(a.events.map((e) => [e.name, e.attributes])).toEqual([
      ["wrapUp", { stopped: true }],
      ["steer", {}],
    ]);
    expect(span("invoke_workflow f").events.map((e) => e.name)).toEqual(["skip"]);
  });

  it("uses the global tracer when none is given", () => {
    trace.setGlobalTracerProvider(provider);
    const flow = Flow.start<void>("f").build();
    tracing(flow, { runId: "r" }).end();
    expect(span("invoke_workflow f").instrumentationScope.name).toBe("ayaito");
  });
});
