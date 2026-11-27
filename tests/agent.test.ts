import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  agentNode,
  defineRuntime,
  exec,
  FsStore,
  type RawRequest,
  type RawResult,
  refine,
  refineNode,
  run,
  usageReport,
} from "../src/index.ts";

const tmpStore = async () => new FsStore(await mkdtemp(join(tmpdir(), "ayaito-")));

/** A runtime that answers each call with the next of answers, and keeps the requests. */
function scripted(answers: unknown[], usage: Pick<RawResult, "costUsd" | "models"> = {}) {
  const seen: RawRequest[] = [];
  const runtime = defineRuntime({
    name: "scripted",
    run: async (request) => {
      seen.push(request);
      return { text: "", structured: answers[seen.length - 1], sessionId: "s1", ...usage };
    },
  });
  return { runtime, seen };
}

const tokens = { input: 10, output: 2000, cacheRead: 30000, cacheCreation: 4000 };

describe("agentNode", () => {
  it("returns the validated output, passes the request on, and reports usage per node", async () => {
    const { runtime, seen } = scripted([{ topic: "婚活" }, { topic: "婚活" }], {
      costUsd: 0.5,
      models: { "claude-opus-5-5": tokens },
    });
    const store = await tmpStore();
    const node = agentNode(
      "pick",
      {
        prompt: (n: number) => `pick ${n}`,
        output: z.object({ topic: z.string() }),
        system: "sys",
        cwd: "/x",
        access: "read-only",
      },
      runtime,
    );

    const { output, costUsd } = await run(node, 3, { runId: "r", store });
    await run(node, 4, { runId: "r", store });

    expect(output).toEqual({ topic: "婚活" });
    expect(costUsd).toBe(0.5);
    expect(usageReport(await store.events("r"))).toContain("| pick | 2 | 20 | 4,000 | 60,000 | 8,000 | 1.00 |");
    expect(seen[0]).toMatchObject({ prompt: "pick 3", node: "pick", system: "sys", cwd: "/x", access: "read-only" });
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.outputSchema).toMatchObject({ type: "object", required: ["topic"] });
    expect(seen[0]?.outputSchema).not.toHaveProperty("$schema");
  });

  it("sends schema issues back to the same session, and throws once attempts run out", async () => {
    const out = z.object({ topic: z.string().min(1) });
    const fixed = scripted([{ topic: "" }, { topic: "婚活" }]);
    const { output, events } = await run(
      agentNode("pick", { prompt: () => "pick", output: out, attempts: 2 }, fixed.runtime),
      0,
      { runId: "r", store: await tmpStore() },
    );
    expect(output).toEqual({ topic: "婚活" });
    expect(fixed.seen[1]?.sessionId).toBe("s1");
    expect(fixed.seen[1]?.prompt).toContain("- topic:");
    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);

    const never = scripted([{ topic: 1 }]);
    await expect(
      run(agentNode("pick", { prompt: () => "pick", output: out }, never.runtime), 0, {
        runId: "r",
        store: await tmpStore(),
      }),
    ).rejects.toThrow("pick: Your final answer does not match the output schema");
  });

  it("reports tokens without a cost as '-'", async () => {
    const { runtime } = scripted([{ ok: true }], { models: { codex: tokens } });
    const store = await tmpStore();
    const { costUsd } = await run(
      agentNode("c", { prompt: () => "", output: z.object({ ok: z.boolean() }) }, runtime),
      0,
      {
        runId: "r",
        store,
      },
    );
    expect(costUsd).toBe(0);
    expect(usageReport(await store.events("r"))).toContain("| c | 1 | 10 | 2,000 | 30,000 | 4,000 | - |");
  });
});

describe("refineNode", () => {
  const out = z.object({ quote: z.string() });

  it("sends check's feedback back until it passes, with the node's input", async () => {
    const { runtime, seen } = scripted([{ quote: "invented" }, { quote: "real" }]);
    const node = refineNode(
      "cite",
      {
        prompt: (paper: string) => `cite ${paper}`,
        output: out,
        check: (r, paper) =>
          paper.includes(r.structured.quote)
            ? { ok: true, value: r.structured.quote.toUpperCase() }
            : { ok: false, feedback: `not in the paper: ${r.structured.quote}` },
        maxAttempts: 3,
      },
      runtime,
    );

    const { output } = await run(node, "a real paper", { runId: "r", store: await tmpStore() });

    expect(output).toEqual({ ok: true, value: "REAL", attempts: 2, sessionId: "s1" });
    expect(seen[1]).toMatchObject({ prompt: "not in the paper: invented", node: "cite", sessionId: "s1" });
  });

  it("returns what never passed as a result", async () => {
    const { runtime, seen } = scripted([{ quote: "a" }, { quote: "b" }]);
    const { output } = await run(
      refineNode(
        "cite",
        {
          prompt: () => "cite",
          output: out,
          check: (r) => ({ ok: false, feedback: `no: ${r.structured.quote}` }),
          maxAttempts: 2,
        },
        runtime,
      ),
      0,
      { runId: "r", store: await tmpStore() },
    );
    expect(output).toEqual({ ok: false, feedback: "no: b", attempts: 2, sessionId: "s1" });
    expect(seen).toHaveLength(2);
  });

  it("passes the node's ctx to check, whose signal aborts with the run", async () => {
    const { runtime } = scripted([{ quote: "a" }]);
    const controller = new AbortController();
    let aborted = false;
    const node = refineNode(
      "cite",
      {
        prompt: () => "cite",
        output: out,
        check: (_r, _input, _attempt, ctx) =>
          new Promise<never>((_, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(ctx.signal.reason as Error);
              },
              { once: true },
            );
            controller.abort(new Error("stopped"));
          }),
        maxAttempts: 1,
      },
      runtime,
    );
    await expect(run(node, 0, { runId: "r", store: await tmpStore(), signal: controller.signal })).rejects.toThrow(
      "stopped",
    );
    expect(aborted).toBe(true);
  });

  it("kills a process check started with ctx.signal when the run stops", async () => {
    const { runtime } = scripted([{ quote: "a" }]);
    const controller = new AbortController();
    const pidFile = join(await mkdtemp(join(tmpdir(), "ayaito-")), "pid");
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000);`;
    const node = refineNode(
      "test",
      {
        prompt: () => "fix",
        output: out,
        check: async (_r, _input, _attempt, ctx) => {
          const { code } = await exec(process.execPath, ["-e", script], { signal: ctx.signal });
          return code === 0 ? { ok: true, value: "passed" } : { ok: false, feedback: "failed" };
        },
        maxAttempts: 1,
      },
      runtime,
    );
    const done = run(node, 0, { runId: "r", store: await tmpStore(), signal: controller.signal });
    let pid: number | undefined;
    while (pid === undefined) {
      pid = Number(await readFile(pidFile, "utf8").catch(() => "")) || undefined;
      if (pid === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    controller.abort(new Error("stopped"));
    await expect(done).rejects.toThrow("The operation was aborted");
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false);
  });
});

describe("refine", () => {
  it("counts an answer that misses the schema as a failed attempt", async () => {
    const { runtime } = scripted([{ quote: 1 }, { quote: "ok" }]);
    const result = await refine({
      runtime,
      request: { prompt: "cite", output: z.object({ quote: z.string() }) },
      check: (r) => ({ ok: true, value: r.structured.quote }),
      maxAttempts: 2,
    });
    expect(result).toEqual({ ok: true, value: "ok", attempts: 2, sessionId: "s1" });
  });
});
