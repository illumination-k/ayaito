import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { codexRuntime } from "../src/codex.ts";
import { InterruptedError, OutputError } from "../src/runtime.ts";

/**
 * A codex executable that records how it was called and prints events, as `codex exec
 * --experimental-json` does. With hang, it waits to be killed after the events.
 */
async function fakeCodex(events: object[], opts: { hang?: boolean; exit?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ayaito-codex-"));
  const calls = join(dir, "calls.jsonl");
  const path = join(dir, "codex");
  await writeFile(
    path,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), input }) + "\\n");
  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
  if (${opts.hang === true}) setInterval(() => {}, 1000);
  else process.exitCode = ${opts.exit ?? 0};
});
`,
  );
  await chmod(path, 0o755);
  const seen = async () =>
    (await readFile(calls, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
  return { path, seen };
}

const started = { type: "thread.started", thread_id: "th1" };
const usage = { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20, cache_write_input_tokens: 5 };
const message = (text: string) => ({ type: "item.completed", item: { id: "m", type: "agent_message", text } });

describe("codexRuntime", () => {
  it("answers with the last message, its usage and thread, read-only and without approvals", async () => {
    const codex = await fakeCodex([
      started,
      { type: "turn.started" },
      message("thinking"),
      message('{"topic":"a"}'),
      // Items after the answer that are not a finished message do not replace it.
      { type: "item.started", item: { id: "c", type: "command_execution", command: "ls" } },
      { type: "item.completed", item: { id: "r", type: "reasoning", text: "hm" } },
      { type: "turn.completed", usage },
    ]);
    const sessions: string[] = [];

    const answer = await codexRuntime({ codexPathOverride: codex.path }).run({
      prompt: "pick",
      model: "gpt-x",
      cwd: "/work",
      output: z.object({ topic: z.string() }),
      onSession: (id) => sessions.push(id),
    });

    expect(answer).toMatchObject({
      text: '{"topic":"a"}',
      structured: { topic: "a" },
      sessionId: "th1",
      models: { "gpt-x": { input: 70, output: 20, cacheRead: 30, cacheCreation: 5 } },
    });
    expect(sessions).toEqual(["th1"]);
    const [call] = await codex.seen();
    expect(call?.input).toMatch(/^pick/);
    expect(call?.args).toEqual(
      expect.arrayContaining(["--model", "gpt-x", "--sandbox", "read-only", "--cd", "/work", "--skip-git-repo-check"]),
    );
    expect(call?.args).toContain('approval_policy="never"');
    expect(call?.args).toContain("--output-schema");
  });

  it("resumes a thread with write access, the system prompt as developer instructions", async () => {
    const codex = await fakeCodex([message("done")]);
    const sessions: string[] = [];
    const answer = await codexRuntime({ codexPathOverride: codex.path }).run({
      prompt: "go",
      system: "be brief",
      access: "write",
      sessionId: "old",
      onSession: (id) => sessions.push(id),
    });
    expect(answer).toMatchObject({ text: "done", sessionId: "old" });
    expect(sessions).toEqual(["old"]);
    expect(answer.models).toBeUndefined();
    const [call] = await codex.seen();
    expect(call?.args).toEqual(expect.arrayContaining(["--sandbox", "danger-full-access", "resume", "old"]));
    expect(call?.args).toContain('developer_instructions="be brief"');
  });

  it("reports commands, tools, file changes, searches and messages as they go", async () => {
    const item = (type: string, isDone: boolean, fields: object) => ({
      type: isDone ? "item.completed" : "item.started",
      item: { id: type, type, ...fields },
    });
    const codex = await fakeCodex([
      started,
      item("command_execution", false, { command: "ls -la" }),
      item("command_execution", true, { command: "ls -la" }),
      item("mcp_tool_call", false, { server: "srv", tool: "look", arguments: { q: 1 } }),
      item("file_change", true, {
        changes: [
          { kind: "update", path: "a.ts" },
          { kind: "add", path: "b.ts" },
        ],
      }),
      item("web_search", true, { query: "ayaito" }),
      item("reasoning", true, { text: "hm" }),
      item("agent_message", false, { text: "partial" }),
      message("  "),
      message("All done."),
    ]);
    const seen: unknown[] = [];
    await codexRuntime({ codexPathOverride: codex.path }).run({ prompt: "", onActivity: (a) => seen.push(a) });
    expect(seen).toEqual([
      { tool: "command", text: "ls -la" },
      { tool: "srv/look", text: '{"q":1}' },
      { tool: "file_change", text: "update a.ts, add b.ts" },
      { tool: "web_search", text: "ayaito" },
      { text: "All done." },
    ]);
  });

  it("fails on a failed turn, an answer that is not JSON, and a turn with no thread", async () => {
    const failed = await fakeCodex([started, { type: "turn.failed", error: { message: "quota" } }]);
    await expect(codexRuntime({ codexPathOverride: failed.path }).run({ prompt: "" })).rejects.toThrow("quota");

    const prose = await fakeCodex([started, message("no JSON here"), { type: "turn.completed", usage }]);
    const error = await codexRuntime({ codexPathOverride: prose.path })
      .run({ prompt: "", output: z.object({ topic: z.string() }) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutputError);
    expect(error).toMatchObject({
      sessionId: "th1",
      message: expect.stringContaining("- (root): the answer could not be parsed as JSON"),
      usage: { models: { codex: { input: 70 } } },
    });

    const silent = await fakeCodex([started]);
    expect(await codexRuntime({ codexPathOverride: silent.path }).run({ prompt: "" })).toMatchObject({ text: "" });

    const nothing = await fakeCodex([message("hi")]);
    await expect(codexRuntime({ codexPathOverride: nothing.path }).run({ prompt: "" })).rejects.toThrow(
      "codex: no thread id after the turn",
    );

    const crashed = await fakeCodex([], { exit: 3 });
    await expect(codexRuntime({ codexPathOverride: crashed.path }).run({ prompt: "" })).rejects.toThrow("code 3");
  });

  it("throws InterruptedError with the thread when the signal aborts a started thread", async () => {
    const codex = await fakeCodex([started], { hang: true });
    const controller = new AbortController();
    const reason = new Error("stopped");
    const running = codexRuntime({ codexPathOverride: codex.path }).run({
      prompt: "",
      signal: controller.signal,
      onSession: () => setTimeout(() => controller.abort(reason), 50),
    });
    const error = await running.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InterruptedError);
    expect(error).toMatchObject({ sessionId: "th1", message: "stopped" });
  });
});
