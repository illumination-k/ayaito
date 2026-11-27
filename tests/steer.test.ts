import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  agentNode,
  defineRuntime,
  Flow,
  forEach,
  FsStore,
  InterruptedError,
  type RawRequest,
  type RawResult,
  refineNode,
  run,
  steering,
  timeout,
} from "../src/index.ts";
import { STOP_PROMPT, steerPrompt } from "../src/refine.ts";

const tmpStore = async () => new FsStore(await mkdtemp(join(tmpdir(), "ayaito-")));
const output = z.object({ found: z.number() });
const answer = (found: number): RawResult => ({ text: "", sessionId: "s1", structured: { found }, costUsd: 0.05 });

/** A runtime whose turns are scripted. started resolves each time a turn begins. */
function scripted(turns: ((request: RawRequest) => Promise<RawResult>)[]) {
  const seen: { prompt: string; sessionId?: string }[] = [];
  let begun = () => {};
  const runtime = defineRuntime({
    name: "fake",
    run: async (request) => {
      seen.push({ prompt: request.prompt, sessionId: request.sessionId });
      begun();
      const turn = turns.shift();
      if (!turn) throw new Error("no turn left");
      return turn(request);
    },
  });
  return { runtime, seen, started: () => new Promise<void>((resolve) => (begun = resolve)) };
}

/** A turn that works until it is interrupted, as a runtime does once its session has started. */
const untilAborted = ({ signal }: RawRequest) =>
  new Promise<never>((_, reject) =>
    signal?.addEventListener("abort", () => reject(new InterruptedError("s1", signal.reason, { costUsd: 0.25 })), {
      once: true,
    }),
  );

describe("steering", () => {
  it("interrupts the agent at work and gives its session the message", async () => {
    const { runtime, seen, started } = scripted([untilAborted, async () => answer(3)]);
    const research = agentNode("research", { prompt: () => "count", output }, runtime);
    const steer = steering();
    expect(steer.send("research", "too early")).toBe(false);

    const working = started();
    const running = run(Flow.start<undefined>("f").then(research).build(), undefined, {
      runId: "r",
      store: await tmpStore(),
      steer,
    });
    await working;
    expect(steer.send("other", "not for it")).toBe(false);
    expect(steer.send("research", "Only count the open ones.")).toBe(true);

    const { output: found, events, costUsd } = await running;
    expect(found).toEqual({ found: 3 });
    expect(seen).toEqual([
      { prompt: "count", sessionId: undefined },
      { prompt: steerPrompt(["Only count the open ones."]), sessionId: "s1" },
    ]);
    expect(events.filter((e) => e.type === "steer")).toEqual([
      expect.objectContaining({ node: "research", message: "Only count the open ones." }),
    ]);
    // The interrupted turn is counted, and the message is no new attempt.
    expect(costUsd).toBeCloseTo(0.3);
    expect(events.some((e) => e.type === "retry")).toBe(false);
    expect(steer.send("research", "too late")).toBe(false);
  });

  it("sends what comes between calls with the next prompt", async () => {
    const { runtime, seen } = scripted([async () => answer(1), async () => answer(2)]);
    const steer = steering();
    const research = refineNode(
      "research",
      {
        prompt: () => "count",
        output,
        maxAttempts: 2,
        check: (result, _input, attempt) => {
          if (attempt === 1) steer.send("research", "Look in docs too.");
          return result.structured.found > 1 ? { ok: true, value: result.structured } : { ok: false, feedback: "more" };
        },
      },
      runtime,
    );

    const { output: result } = await run(research, undefined, { runId: "r", store: await tmpStore(), steer });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(seen[1]).toEqual({ prompt: `more\n\n${steerPrompt(["Look in docs too."])}`, sessionId: "s1" });
  });

  it("starts the call again with the message when the session had not started", async () => {
    const { runtime, seen, started } = scripted([
      ({ signal }) => new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
      async () => answer(1),
    ]);
    const steer = steering();
    const working = started();
    const running = run(agentNode("research", { prompt: () => "count", output }, runtime), undefined, {
      runId: "r",
      store: await tmpStore(),
      steer,
    });
    await working;
    steer.send("research", "Be quick.");

    expect((await running).output).toEqual({ found: 1 });
    expect(seen[1]).toEqual({ prompt: `count\n\n${steerPrompt(["Be quick."])}`, sessionId: undefined });
  });

  it("asks for the answer too when time is up while a message is passed on", async () => {
    let wrapUp: (() => void) | undefined;
    const { runtime, seen, started } = scripted([
      // Time is up between the interruption and the resumed call.
      async (request) => {
        try {
          return await untilAborted(request);
        } finally {
          await new Promise((resolve) => (wrapUp = () => resolve(undefined)));
        }
      },
      async () => answer(4),
    ]);
    const research = agentNode("research", { prompt: () => "count", output }, runtime);
    const flow = Flow.start<undefined>("f")
      .then(research, { use: [timeout(30, { wrapUp: { ms: 1000, prompt: "Answer now." } })] })
      .build();
    const steer = steering();
    const working = started();
    const running = run(flow, undefined, { runId: "r", store: await tmpStore(), steer });
    await working;
    steer.send("research", "Skip the tests.");
    await new Promise((resolve) => setTimeout(resolve, 60));
    wrapUp?.();

    const { output: found, events } = await running;
    expect(found).toEqual({ found: 4 });
    expect(seen[1]).toEqual({ prompt: `${steerPrompt(["Skip the tests."])}\n\nAnswer now.`, sessionId: "s1" });
    expect(events.filter((e) => e.type === "wrapUp" || e.type === "steer").map((e) => e.type)).toEqual([
      "wrapUp",
      "steer",
    ]);
  });

  it("stops an agent at work, which answers from what it has done, and the flow goes on", async () => {
    const { runtime, seen, started } = scripted([untilAborted, async () => answer(2)]);
    const research = refineNode(
      "research",
      { prompt: () => "count", output, maxAttempts: 3, check: () => ({ ok: false, feedback: "more" }) },
      runtime,
    );
    const steer = steering();
    expect(steer.stop("research")).toBe(false);
    const working = started();
    const running = run(research, undefined, { runId: "r", store: await tmpStore(), steer });
    await working;
    expect(steer.stop("research")).toBe(true);

    const { output: result, events } = await running;
    // No attempt follows the answer of an agent that was stopped.
    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(seen).toEqual([
      { prompt: "count", sessionId: undefined },
      { prompt: STOP_PROMPT, sessionId: "s1" },
    ]);
    expect(events.filter((e) => e.type === "wrapUp")).toEqual([
      expect.objectContaining({ node: "research", stopped: true }),
    ]);
  });

  it("steers and stops an agent that answers as text", async () => {
    const text = (t: string) => async (): Promise<RawResult> => ({ text: t, sessionId: "s1" });
    const { runtime, seen, started } = scripted([untilAborted, untilAborted, text("stopped report")]);
    const review = agentNode("review", { prompt: () => "review" }, runtime);
    const steer = steering();

    let working = started();
    const running = run(review, undefined, { runId: "r", store: await tmpStore(), steer });
    await working;
    working = started();
    expect(steer.send("review", "Look at the tests too.")).toBe(true);
    await working;
    expect(steer.stop("review")).toBe(true);

    const { output: report, events } = await running;
    expect(report).toBe("stopped report");
    expect(seen).toEqual([
      { prompt: "review", sessionId: undefined },
      { prompt: steerPrompt(["Look at the tests too."]), sessionId: "s1" },
      { prompt: STOP_PROMPT, sessionId: "s1" },
    ]);
    expect(events.filter((e) => e.type === "steer" || e.type === "wrapUp").map((e) => e.type)).toEqual([
      "steer",
      "wrapUp",
    ]);
  });

  it("reaches one agent of a forEach by its item, or any agent by its session", async () => {
    // Each agent works in a session named after its prompt, until it is told something.
    const told: Record<string, string> = {};
    let begun = () => {};
    const runtime = defineRuntime({
      name: "fake",
      run: async ({ prompt, sessionId, signal, onSession }) => {
        if (sessionId !== undefined) {
          told[sessionId] = prompt;
          return { text: "", sessionId, structured: { found: 1 } };
        }
        onSession?.(`s-${prompt}`);
        begun();
        return new Promise<never>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new InterruptedError(`s-${prompt}`, signal.reason))),
        );
      },
    });
    const each = forEach("fix each", agentNode("fix", { prompt: (task: string) => task, output }, runtime));
    const steer = steering();
    const working = new Promise<void>((resolve) => {
      let count = 0;
      begun = () => ++count === 3 && resolve();
    });
    const running = run(Flow.start<string[]>("f").then(each).build(), ["a", "b", "c"], {
      runId: "r",
      store: await tmpStore(),
      steer,
    });
    await working;
    expect(steer.send("fix#3", "nobody")).toBe(false);
    steer.send("fix#1", "to b");
    steer.send("s-c", "to c");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Object.keys(told)).toEqual(["s-b", "s-c"]);
    steer.stop("fix");

    const { events } = await running;
    expect(told).toEqual({ "s-b": steerPrompt(["to b"]), "s-c": steerPrompt(["to c"]), "s-a": STOP_PROMPT });
    expect(events.filter((e) => e.type === "session").map((e) => [e.item, e.sessionId])).toEqual([
      ["0", "s-a"],
      ["1", "s-b"],
      ["2", "s-c"],
    ]);
    expect(events.filter((e) => e.type === "start" && e.node === "fix").map((e) => e.item)).toEqual(["0", "1", "2"]);
    expect(events.find((e) => e.type === "steer" && e.message === "to b")).toMatchObject({ node: "fix", item: "1" });
  });

  it("records what the agent says and the tools it calls", async () => {
    const { runtime } = scripted([
      async ({ onActivity }) => {
        onActivity?.({ text: "I will look." });
        onActivity?.({ tool: "Read", text: '{"file_path":"a.ts"}' });
        onActivity?.({ text: "x".repeat(3000) });
        return answer(1);
      },
    ]);
    const research = agentNode("research", { prompt: () => "count", output }, runtime);

    const { events } = await run(research, undefined, { runId: "r", store: await tmpStore() });
    const activity = events.filter((e) => e.type === "activity");
    expect(activity.slice(0, 2)).toEqual([
      { type: "activity", node: "research", at: expect.any(String), text: "I will look." },
      { type: "activity", node: "research", at: expect.any(String), tool: "Read", text: '{"file_path":"a.ts"}' },
    ]);
    expect(activity[2]?.text).toHaveLength(1001);
  });
});
