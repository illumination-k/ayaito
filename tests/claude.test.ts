import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { claudeRuntime } from "../src/claude.ts";
import { InterruptedError } from "../src/runtime.ts";

const result = (fields: Record<string, unknown>) =>
  ({
    type: "result",
    subtype: "success",
    session_id: "s1",
    result: "done",
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
  }) as unknown as SDKMessage;

const fakeQuery = (message: SDKMessage, seen: { prompt: string; options?: Options }[] = []) =>
  async function* (params: { prompt: string; options?: Options }): AsyncGenerator<SDKMessage> {
    seen.push(params);
    yield message;
  };

describe("claudeRuntime", () => {
  it("maps the request onto the SDK options and reports cost and tokens", async () => {
    const seen: { prompt: string; options?: Options }[] = [];
    const runtime = claudeRuntime(
      { maxTurns: 5, allowedTools: ["WebSearch"] },
      fakeQuery(result({ structured_output: { topic: "婚活" } }), seen),
    );

    const answer = await runtime.run({
      prompt: "pick",
      system: "sys",
      cwd: "/x",
      sessionId: "s0",
      output: z.object({ topic: z.string() }),
    });

    expect(answer).toMatchObject({ structured: { topic: "婚活" }, sessionId: "s1", costUsd: 0.5 });
    expect(answer.models?.["claude-opus-5-5"]).toEqual({
      input: 10,
      output: 2000,
      cacheRead: 30000,
      cacheCreation: 4000,
    });
    expect(seen[0]?.options).toMatchObject({
      model: "claude-opus-5-5",
      settingSources: ["project"],
      maxTurns: 5,
      allowedTools: ["WebSearch"],
      systemPrompt: "sys",
      cwd: "/x",
      resume: "s0",
    });
    expect(seen[0]?.options?.outputFormat?.schema).toMatchObject({ required: ["topic"] });
  });

  it("lets access replace the tools and permissions", async () => {
    const seen: { prompt: string; options?: Options }[] = [];
    await claudeRuntime({ allowedTools: ["WebSearch"] }, fakeQuery(result({}), seen)).run({
      prompt: "",
      access: "read-only",
    });
    expect(seen[0]?.options).toMatchObject({
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "dontAsk",
    });
  });

  it("interrupts the turn on abort and reports the session and its usage", async () => {
    let interrupted = false;
    const query = () => {
      let resolve = () => {};
      const stopped = new Promise<void>((r) => (resolve = r));
      return Object.assign(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s9" } as unknown as SDKMessage;
          await stopped;
          yield result({ subtype: "error_during_execution", session_id: "s9", errors: [] });
          throw new Error("Claude Code returned an error result");
        })(),
        { interrupt: async () => ((interrupted = true), resolve()) },
      );
    };
    const abort = new AbortController();
    const running = claudeRuntime({}, query).run({ prompt: "", signal: abort.signal });
    setTimeout(() => abort.abort(new Error("time is up")), 5);

    const error = await running.catch((e: unknown) => e);
    expect(interrupted).toBe(true);
    expect(error).toBeInstanceOf(InterruptedError);
    expect(error).toMatchObject({ sessionId: "s9", message: "time is up", usage: { costUsd: 0.5 } });
  });

  it("keeps the session of a Claude Code that runs it out of the environment", async () => {
    const seen: { prompt: string; options?: Options }[] = [];
    process.env.CLAUDE_CODE_SESSION_ID = "parent";
    try {
      await claudeRuntime({}, fakeQuery(result({}), seen)).run({ prompt: "" });
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    expect(seen[0]?.options?.env).toHaveProperty("CLAUDE_CODE_SESSION_ID", undefined);
    expect(seen[0]?.options?.env?.PATH).toBe(process.env.PATH);
  });

  it("throws when the agent fails", async () => {
    const failed = claudeRuntime({}, fakeQuery(result({ subtype: "error_max_budget_usd", errors: ["over budget"] })));
    await expect(failed.run({ prompt: "" })).rejects.toThrow("claude: error_max_budget_usd: over budget");
    const apiError = claudeRuntime({}, fakeQuery(result({ is_error: true, result: "API Error: 400 invalid schema" })));
    await expect(apiError.run({ prompt: "" })).rejects.toThrow("claude: API Error: 400 invalid schema");
  });
});
