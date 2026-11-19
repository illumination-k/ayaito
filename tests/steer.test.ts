import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  agentNode,
  defineRuntime,
  Flow,
  FsStore,
  InterruptedError,
  type RawRequest,
  type RawResult,
  refineNode,
  run,
  steering,
  timeout,
} from "../src/index.ts";
import { steerPrompt } from "../src/refine.ts";

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
      (request) => untilAborted(request).finally(() => new Promise((resolve) => (wrapUp = () => resolve(undefined)))),
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
