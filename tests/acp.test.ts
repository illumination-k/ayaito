import {
  agent,
  type AgentCapabilities,
  methods,
  type PermissionOption,
  type ToolKind,
  type Usage,
} from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { acpRuntime, type AcpRuntimeOptions } from "../src/acp.ts";
import { OutputError } from "../src/runtime.ts";

const OPTIONS: PermissionOption[] = [
  { optionId: "yes", name: "Allow", kind: "allow_once" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

interface Turn {
  /** Message chunks, each after a tool call when there are several. */
  says: string[];
  /** A tool the agent asks permission for before it answers. */
  asks?: ToolKind;
  /** The cost of the session after the turn. */
  cost?: number;
  currency?: string;
  stopReason?: "end_turn" | "max_tokens" | "refusal";
  usage?: Usage;
  /** Waits for session/cancel instead of answering. */
  hangs?: boolean;
}

/** An ACP agent in this process that plays turns and records what it was sent. */
function fakeAgent(turns: Turn[], capabilities: AgentCapabilities = {}, options: Partial<AcpRuntimeOptions> = {}) {
  const seen = { requests: [] as [method: string, params: unknown][], outcomes: [] as unknown[] };
  let cancel = () => {};
  const cancelled = new Promise<void>((resolve) => (cancel = resolve));
  let created = 0;
  const record =
    <P, R>(reply: (params: P) => R) =>
    ({ method, params }: { method: string; params: P }) => {
      seen.requests.push([method, params]);
      return reply(params);
    };
  const configOptions = [
    {
      type: "select" as const,
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "small",
      options: [
        { value: "small", name: "Small" },
        { value: "large", name: "Large" },
      ],
    },
  ];
  const app = agent({ name: "fake" })
    .onRequest(
      methods.agent.initialize,
      record(() => ({ protocolVersion: 1, agentCapabilities: capabilities })),
    )
    .onRequest(
      methods.agent.session.new,
      record(() => ({ sessionId: `s${++created}`, configOptions })),
    )
    .onRequest(
      methods.agent.session.resume,
      record(() => ({})),
    )
    .onRequest(
      methods.agent.session.load,
      record((): never => {
        throw new Error("no such session");
      }),
    )
    .onRequest(
      methods.agent.session.setConfigOption,
      record(() => ({ configOptions })),
    )
    .onNotification(methods.agent.session.cancel, () => cancel())
    .onRequest(methods.agent.session.prompt, async ({ method, params, client }) => {
      seen.requests.push([method, params]);
      const turn = turns.shift();
      if (!turn) throw new Error("no turn left");
      const { sessionId } = params;
      if (turn.hangs) {
        await cancelled;
        return { stopReason: "cancelled" as const };
      }
      if (turn.asks) {
        const { outcome } = await client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: "t1", kind: turn.asks },
          options: OPTIONS,
        });
        seen.outcomes.push(outcome);
      }
      for (const [i, text] of turn.says.entries()) {
        if (i > 0) {
          const update = { sessionUpdate: "tool_call" as const, toolCallId: `t${i}`, title: "tool" };
          await client.notify(methods.client.session.update, { sessionId, update });
        }
        for (const half of [text.slice(0, 3), text.slice(3)]) {
          const update = {
            sessionUpdate: "agent_message_chunk" as const,
            content: { type: "text" as const, text: half },
          };
          await client.notify(methods.client.session.update, { sessionId, update });
        }
      }
      if (turn.cost !== undefined) {
        const cost = { amount: turn.cost, currency: turn.currency ?? "USD" };
        const update = { sessionUpdate: "usage_update" as const, used: 1, size: 2, cost };
        await client.notify(methods.client.session.update, { sessionId, update });
      }
      return { stopReason: turn.stopReason ?? "end_turn", usage: turn.usage };
    });
  const runtime = acpRuntime({ command: "fake", ...options }, (client) => ({
    connection: client.connect(app),
    close() {},
  }));
  const sent = (method: string) => seen.requests.filter(([m]) => m === method).map(([, params]) => params);
  return { runtime, seen, sent };
}

describe("acpRuntime", () => {
  it("answers with the message after the last tool call, parsed against the schema", async () => {
    const { runtime, sent } = fakeAgent([{ says: ["I will look.", 'Here it is:\n```json\n{"topic":"婚活"}\n```'] }]);

    const answer = await runtime.run({
      prompt: "pick",
      system: "sys",
      cwd: "/x",
      output: z.object({ topic: z.string() }),
    });

    expect(answer).toMatchObject({ structured: { topic: "婚活" }, sessionId: "s1" });
    expect(answer.costUsd).toBeUndefined();
    expect(sent("session/new")).toEqual([{ cwd: "/x", mcpServers: [] }]);
    const [prompt] = sent("session/prompt") as { prompt: { text: string }[] }[];
    expect(prompt?.prompt[0]?.text).toMatch(/^sys\n\npick\n\nAnswer with only a JSON value.*"required":\["topic"\]/s);
  });

  it("sends the system prompt with the session when the agent takes one", async () => {
    const { runtime, sent } = fakeAgent([{ says: ["done"] }], { sessionCapabilities: { systemPrompt: {} } });
    await runtime.run({ prompt: "go", system: "sys", cwd: "/x" });
    expect(sent("session/new")).toMatchObject([
      { systemPrompt: { mode: "append", content: [{ type: "text", text: "sys" }] } },
    ]);
    expect(sent("session/prompt")).toMatchObject([{ prompt: [{ type: "text", text: "go" }] }]);
  });

  it("answers permission requests by the access of the call", async () => {
    const { runtime, seen } = fakeAgent([
      { says: ["a"], asks: "read" },
      { says: ["b"], asks: "edit" },
      { says: ["c"], asks: "execute" },
    ]);
    await runtime.run({ prompt: "" });
    await runtime.run({ prompt: "" });
    await runtime.run({ prompt: "", access: "write" });
    expect(seen.outcomes).toEqual([
      { outcome: "selected", optionId: "yes" },
      { outcome: "selected", optionId: "no" },
      { outcome: "selected", optionId: "yes" },
    ]);
  });

  it("keeps a session for the next call and reports the cost of each turn", async () => {
    const { runtime, sent } = fakeAgent([
      { says: ["one"], cost: 0.5 },
      {
        says: ["two"],
        cost: 0.75,
        usage: { totalTokens: 175, inputTokens: 10, outputTokens: 20, thoughtTokens: 5, cachedReadTokens: 140 },
      },
    ]);
    const first = await runtime.run({ prompt: "1", system: "sys" });
    const second = await runtime.run({ prompt: "2", system: "sys", sessionId: first.sessionId, model: "large" });

    expect([first.text, first.costUsd]).toEqual(["one", 0.5]);
    expect([second.text, second.costUsd, second.sessionId]).toEqual(["two", 0.25, "s1"]);
    expect(first.models).toBeUndefined();
    expect(second.models).toEqual({ large: { input: 10, output: 25, cacheRead: 140, cacheCreation: 0 } });
    expect(sent("session/new")).toHaveLength(1);
    expect(sent("session/set_config_option")).toEqual([{ sessionId: "s1", configId: "model", value: "large" }]);
    // The system prompt leads the first prompt only.
    expect(sent("session/prompt")).toMatchObject([{ prompt: [{ text: "sys\n\n1" }] }, { prompt: [{ text: "2" }] }]);
  });

  it("resumes a session of an earlier process, or fails when the agent cannot", async () => {
    const meta = { claudeCode: { options: { maxTurns: 5 } } };
    const able = fakeAgent([{ says: ["back"] }, { says: ["new"] }], { sessionCapabilities: { resume: {} } }, { meta });
    await expect(able.runtime.run({ prompt: "", sessionId: "old", cwd: "/x" })).resolves.toMatchObject({
      text: "back",
      sessionId: "old",
    });
    expect(able.sent("session/resume")).toEqual([{ sessionId: "old", cwd: "/x", mcpServers: [], _meta: meta }]);
    await able.runtime.run({ prompt: "", cwd: "/x" });
    expect(able.sent("session/new")).toEqual([{ cwd: "/x", mcpServers: [], _meta: meta }]);

    const unable = fakeAgent([]);
    await expect(unable.runtime.run({ prompt: "", sessionId: "old" })).rejects.toThrow("cannot resume session old");
  });

  it("forgets a session the agent fails to load, so the next call loads it again", async () => {
    const { runtime, sent } = fakeAgent([{ says: ["hi"] }], { loadSession: true });
    await expect(runtime.run({ prompt: "", sessionId: "old" })).rejects.toThrow("Internal error");
    await expect(runtime.run({ prompt: "", sessionId: "old" })).rejects.toThrow("Internal error");
    expect(sent("session/load")).toHaveLength(2);
    expect(sent("session/prompt")).toEqual([]);
  });

  it("fails a call when the agent's process exits or cannot start", async () => {
    const exits = acpRuntime({ command: process.execPath, args: ["-e", "process.exit(2)"] });
    // The SDK fails the pending request with its own message, not the exit's.
    await expect(exits.run({ prompt: "" })).rejects.toThrow(/closed|exited/);
    await exits.close();
    const missing = acpRuntime({ command: "ayaito-no-such-agent" });
    await expect(missing.run({ prompt: "" })).rejects.toThrow("ENOENT");
    await missing.close();
  });

  it.each([
    ['{"topic":"a"}', { topic: "a" }],
    ['```\n{"topic":"a"}\n```', { topic: "a" }],
    ['```json  \n{"topic":"a"}\n```', { topic: "a" }],
    ['The answer is {"topic":"a"}. Done.', { topic: "a" }],
    ['Here: [{"topic":"a"},{"topic":"b"}]', [{ topic: "a" }, { topic: "b" }]],
  ])("finds the JSON in %j", async (text, structured) => {
    const { runtime } = fakeAgent([{ says: [text] }]);
    const output = z.union([z.object({ topic: z.string() }), z.array(z.object({ topic: z.string() }))]);
    expect(await runtime.run({ prompt: "", output })).toMatchObject({ structured });
  });

  it("throws an OutputError that keeps the session when the answer is not JSON", async () => {
    const { runtime } = fakeAgent([{ says: ["I could not decide."], cost: 0.1 }]);
    const error = await runtime.run({ prompt: "", output: z.object({ topic: z.string() }) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutputError);
    expect(error).toMatchObject({ sessionId: "s1", usage: { costUsd: 0.1 } });
  });

  it("reports each message and tool call as the turn goes", async () => {
    const { runtime } = fakeAgent([{ says: ["I will look.", "It is done."] }]);
    const seen: unknown[] = [];
    await runtime.run({ prompt: "go", onActivity: (activity) => seen.push(activity) });
    expect(seen).toEqual([{ text: "I will look." }, { tool: "tool", text: "tool" }, { text: "It is done." }]);
  });

  it("reports no message that is only white space", async () => {
    const { runtime } = fakeAgent([{ says: ["  ", "done"] }]);
    const seen: unknown[] = [];
    await runtime.run({ prompt: "go", onActivity: (activity) => seen.push(activity) });
    expect(seen).toEqual([{ tool: "tool", text: "tool" }, { text: "done" }]);
  });

  it("fails a turn that does not end, and counts only a cost in USD", async () => {
    const { runtime } = fakeAgent([
      { says: ["half"], stopReason: "max_tokens" },
      { says: ["ok"], cost: 3, currency: "EUR" },
    ]);
    await expect(runtime.run({ prompt: "" })).rejects.toThrow("acp: the turn ended with max_tokens");
    expect((await runtime.run({ prompt: "" })).costUsd).toBeUndefined();
  });

  it("cancels the turn when the signal aborts", async () => {
    const { runtime } = fakeAgent([{ says: [], hangs: true }]);
    const controller = new AbortController();
    const running = runtime.run({ prompt: "", signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 10);
    await expect(running).rejects.toThrow("stop");
  });
});
