import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  agentNode,
  type AgentRequest,
  defineRuntime,
  Flow,
  FsStore,
  InterruptedError,
  type RawRequest,
  type RawResult,
  run,
  timeout,
  TimeoutError,
} from "../src/index.ts";

const tmpStore = async () => new FsStore(await mkdtemp(join(tmpdir(), "ayaito-")));
const untilAborted = (signal: AbortSignal | undefined) =>
  new Promise<never>((_, reject) =>
    signal?.addEventListener("abort", () => reject(new InterruptedError("s1", signal.reason, { costUsd: 0.25 })), {
      once: true,
    }),
  );

/** A runtime whose turns are scripted: each gets the request and returns an answer, or hangs until aborted. */
function scripted(turns: ((request: RawRequest) => Promise<RawResult>)[]) {
  const seen: Omit<AgentRequest, "signal">[] = [];
  const runtime = defineRuntime({
    name: "fake",
    run: async ({ signal, ...request }) => {
      seen.push(request);
      const turn = turns.shift();
      if (!turn) throw new Error("no turn left");
      return turn({ ...request, signal });
    },
  });
  return { runtime, seen };
}

describe("timeout with wrapUp", () => {
  it("interrupts the agent when time is up and asks the same session for its answer", async () => {
    const { runtime, seen } = scripted([
      ({ signal }) => untilAborted(signal),
      async () => ({ text: "", sessionId: "s1", structured: { found: 2 }, costUsd: 0.05 }),
    ]);
    const research = agentNode("research", { prompt: () => "count", output: z.object({ found: z.number() }) }, runtime);
    const flow = Flow.start<undefined>("f")
      .then(research, { use: [timeout(20, { wrapUp: { ms: 1000, prompt: "Answer now." } })] })
      .build();

    const started = Date.now();
    const { output, events, costUsd } = await run(flow, undefined, { runId: "r", store: await tmpStore() });

    expect(output).toEqual({ found: 2 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(seen.map((r) => [r.prompt, r.sessionId])).toEqual([
      ["count", undefined],
      ["Answer now.", "s1"],
    ]);
    expect(events.filter((e) => e.type === "wrapUp")).toEqual([expect.objectContaining({ node: "research" })]);
    // The interrupted turn is counted too.
    expect(costUsd).toBeCloseTo(0.3);
  });

  it("times out when the wrap-up does not answer in time either", async () => {
    const { runtime } = scripted([({ signal }) => untilAborted(signal), ({ signal }) => untilAborted(signal)]);
    const research = agentNode("research", { prompt: () => "count", output: z.object({ found: z.number() }) }, runtime);
    const flow = Flow.start<undefined>("f")
      .then(research, { use: [timeout(10, { wrapUp: { ms: 20 } })] })
      .build();

    const error = await run(flow, undefined, { runId: "r", store: await tmpStore() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ message: "research: timed out after 30ms" });
  });

  it("asks an agent that starts after time is up to answer at once, and refines no further", async () => {
    const { runtime, seen } = scripted([
      async () => ({ text: "", sessionId: "s1", structured: { found: -1 } }),
      async () => ({ text: "", sessionId: "s1", structured: { found: -1 } }),
    ]);
    const late = agentNode(
      "late",
      { prompt: () => "count", output: z.object({ found: z.number().min(0) }), attempts: 3 },
      runtime,
    );
    const flow = Flow.start<undefined>("f")
      .then(
        Flow.start<undefined>("inner")
          .then({ name: "wait", run: async () => void (await new Promise((r) => setTimeout(r, 30))) })
          .then(late)
          .build(),
        { use: [timeout(10, { wrapUp: { ms: 1000, prompt: "Answer now." } })] },
      )
      .build();

    await expect(run(flow, undefined, { runId: "r", store: await tmpStore() })).rejects.toThrow("late:");
    expect(seen.map((r) => r.prompt)).toEqual(["count\n\nAnswer now."]);
  });
});
