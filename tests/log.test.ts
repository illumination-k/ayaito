import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { agentNode, defineRuntime, fnNode, Flow, formatEvent, FsStore, type RunEvent, run } from "../src/index.ts";

const at = "2026-01-02T03:04:05.000Z";

describe("the audit events of an agent call", () => {
  it("records what each call asked and answered, whole, and what code logs", async () => {
    const long = "x".repeat(5000);
    let calls = 0;
    const runtime = defineRuntime({
      name: "fake",
      run: async () => ({ text: "", sessionId: "s1", structured: { topic: ++calls === 1 ? "" : long } }),
    });
    const pick = agentNode(
      "pick",
      {
        prompt: (n: number) => `pick ${n} ${long}`,
        output: z.object({ topic: z.string().min(1) }),
        model: "m",
        access: "read-only",
        attempts: 2,
      },
      runtime,
    );
    const note = fnNode("note", async (n: number, ctx) => {
      ctx.emit({ type: "log", node: "note", text: `got ${n}` });
      return n;
    });
    const flow = Flow.start<number>("f").then(note).then(pick).build();
    const store = new FsStore(await mkdtemp(join(tmpdir(), "ayaito-")));

    await run(flow, 3, { runId: "r", store });

    const events = (await store.events("r")).map(({ at: _, ...event }) => event);
    expect(events.filter((e) => e.type === "log")).toEqual([{ type: "log", node: "note", text: "got 3" }]);
    const asked = events.filter((e) => e.type === "prompt");
    expect(asked[0]).toEqual({
      type: "prompt",
      node: "pick",
      text: `pick 3 ${long}`,
      runtime: "fake",
      model: "m",
      access: "read-only",
    });
    // The second call gives the schema's issues to the session of the first.
    expect(asked[1]).toMatchObject({ sessionId: "s1", text: expect.stringContaining("- topic:") });
    expect(asked).toHaveLength(2);
    // The answer that missed the schema is a retry; the one that passed is kept as JSON.
    expect(events.filter((e) => e.type === "answer")).toEqual([
      { type: "answer", node: "pick", text: JSON.stringify({ topic: long }) },
    ]);
    expect(events.map((e) => e.type).filter((t) => t === "prompt" || t === "answer" || t === "retry")).toEqual([
      "prompt",
      "retry",
      "prompt",
      "answer",
    ]);
  });

  it("records the text of an agent without an output schema, and no model or access that was not set", async () => {
    const runtime = defineRuntime({ name: "fake", run: async () => ({ text: "hello", sessionId: "s1" }) });
    const { events } = await run(agentNode("say", { prompt: () => "say hello" }, runtime), 0, {
      runId: "r",
      store: new FsStore(await mkdtemp(join(tmpdir(), "ayaito-"))),
    });
    expect(events.map(({ at: _, ...event }) => event)).toEqual([
      { type: "prompt", node: "say", text: "say hello", runtime: "fake" },
      { type: "answer", node: "say", text: "hello" },
    ]);
  });
});

describe("formatEvent", () => {
  // Omit, for each kind of event.
  type What = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at" | "node"> : never) : never;
  const cases: [What, string][] = [
    [{ type: "start" }, "start"],
    [{ type: "end", ms: 1234 }, "end (1.2s)"],
    [{ type: "skip", reason: "checkpoint n.abc" }, "skip: checkpoint n.abc"],
    [{ type: "retry", attempt: 1, error: "bad" }, "retry after attempt 1: bad"],
    [{ type: "error", error: "Error: boom" }, "error: Error: boom"],
    [{ type: "stop", reason: "nothing to do" }, "stop: nothing to do"],
    [{ type: "wrapUp" }, "time is up: asked for its answer"],
    [{ type: "wrapUp", stopped: true }, "told to stop: asked for its answer"],
    [{ type: "session", sessionId: "s1" }, "session s1"],
    [{ type: "prompt", text: "do it", runtime: "claude" }, "prompt (claude): do it"],
    [
      { type: "prompt", text: "fix", runtime: "claude", model: "m", access: "write", sessionId: "s1" },
      "prompt (claude, m, write, resumes s1): fix",
    ],
    [{ type: "answer", text: '{"ok":true}' }, 'answer: {"ok":true}'],
    [{ type: "activity", text: "looking" }, "says: looking"],
    [{ type: "activity", tool: "Read", text: "a.ts" }, "tool Read: a.ts"],
    [{ type: "steer", message: "only open ones" }, "steer: only open ones"],
    [{ type: "log", text: "3 files" }, "log: 3 files"],
    [
      {
        type: "usage",
        usd: 0.5,
        models: {
          a: { input: 1000, output: 200, cacheRead: 9, cacheCreation: 9 },
          b: { input: 30, output: 4, cacheRead: 0, cacheCreation: 0 },
        },
      },
      "usage: $0.50, 1,234 tokens in and out",
    ],
    [{ type: "usage", models: {} }, "usage: 0 tokens in and out"],
  ];

  it.each(cases)("%j", (event, text) => {
    expect(formatEvent({ ...event, node: "n", at })).toBe(`${at} n ${text}`);
  });

  it("names the item of a forEach, and indents the lines after the first", () => {
    expect(formatEvent({ type: "log", node: "fix", item: "2", at, text: "a\nb\nc" })).toBe(
      `${at} fix#2 log: a\n    b\n    c`,
    );
  });
});
