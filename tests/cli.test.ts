import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vite-plus/test";

const cli = (...args: string[]) =>
  promisify(execFile)(process.execPath, [resolve("src/cli.ts"), ...args]).catch(
    (error: { code: number; stdout: string; stderr: string }) => error,
  );

const flowFile = async (dir: string, body: string) => {
  const file = join(dir, "flow.ts");
  await writeFile(file, `import { fnNode, Flow, Stop } from ${JSON.stringify(resolve("src/index.ts"))};\n${body}`);
  return file;
};

describe("ayaito", () => {
  it("runs the flow a file exports and saves the result with the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ayaito-"));
    const file = await flowFile(
      dir,
      `export const input: number = 1;
       export default Flow.start<number>("f").then(fnNode("double", async (n: number) => n * 2)).build();`,
    );

    const own = await cli("run", file, "--store", dir, "--run-id", "a");
    expect(JSON.parse(own.stdout)).toEqual({ runId: "a", status: "done", output: 2, costUsd: 0 });
    expect(JSON.parse(await readFile(join(dir, "a", "result.json"), "utf8"))).toEqual(JSON.parse(own.stdout));

    const given = await cli("run", file, "--store", dir, "--run-id", "b", "--input", "21");
    expect(JSON.parse(given.stdout)).toMatchObject({ status: "done", output: 42 });
  });

  it("exits with 1 and saves the error when the flow fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ayaito-"));
    const file = await flowFile(
      dir,
      `export default Flow.start<number>("f").then(fnNode("boom", async (n: number) => { throw new Error("boom " + n); })).build();`,
    );

    const failed = (await cli("run", file, "--store", dir, "--run-id", "r", "--input", "1")) as { code: number };
    expect(failed.code).toBe(1);
    const result = JSON.parse(await readFile(join(dir, "r", "result.json"), "utf8")) as {
      status: string;
      error: string;
    };
    expect(result.status).toBe("failed");
    expect(result.error).toContain("boom 1");
  });

  it("prints the graph of a flow, as JSON or Mermaid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ayaito-"));
    const file = await flowFile(
      dir,
      `export default Flow.start<number>("f").then(fnNode("a", async (n: number) => n)).build();`,
    );

    const graph = JSON.parse((await cli("graph", file)).stdout) as { nodes: { name?: string }[] };
    expect(graph.nodes.map((n) => n.name)).toEqual([undefined, "f", "a", undefined]);
    expect((await cli("graph", file, "--mermaid")).stdout).toContain('n1["a"]');
  });

  it("sends a message to the agent a run is running, and not to a node that is not at work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ayaito-"));
    const file = join(dir, "flow.ts");
    // An agent that works until it is interrupted, then answers with what it was told.
    await writeFile(
      file,
      `import { agentNode, defineRuntime, Flow, InterruptedError } from ${JSON.stringify(resolve("src/index.ts"))};
       const output = { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }), jsonSchema: { output: () => ({}) } } };
       const runtime = defineRuntime({
         name: "fake",
         run: ({ prompt, sessionId, signal }) =>
           sessionId
             ? Promise.resolve({ text: "", sessionId, structured: prompt })
             : new Promise((_, reject) => signal.addEventListener("abort", () => reject(new InterruptedError("s1", signal.reason)))),
       });
       export default Flow.start("f").then(agentNode("research", { prompt: () => "count", output }, runtime)).build();`,
    );
    const store = ["--store", dir];
    const events = () => readFile(join(dir, "r", "events.jsonl"), "utf8").catch(() => "");

    expect(await cli("steer", "r", "research", "hello", ...store)).toMatchObject({ code: 1 });
    const running = cli("run", file, "--run-id", "r", ...store);
    while (!(await events()).includes('"start","node":"research"')) await new Promise((r) => setTimeout(r, 20));
    expect(await cli("steer", "r", "f", "hello", ...store)).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no agent node or session "f". Its agent nodes: research'),
    });
    expect((await cli("steer", "r", "research", "Only", "the open ones.", ...store)).stdout).toContain("Sent to");

    expect(JSON.parse((await running).stdout)).toMatchObject({
      status: "done",
      output: expect.stringContaining("Only the open ones."),
    });
    expect(await events()).toContain('"type":"steer","node":"research","message":"Only the open ones."');
    expect(await cli("steer", "r", "research", "late", ...store)).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("is not running"),
    });
  });

  it("stops the agent of a node, or the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ayaito-"));
    const file = join(dir, "flow.ts");
    // An agent that never ends by itself: interrupted, it answers with what it is asked then.
    await writeFile(
      file,
      `import { agentNode, defineRuntime, Flow, InterruptedError } from ${JSON.stringify(resolve("src/index.ts"))};
       const output = { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }), jsonSchema: { output: () => ({}) } } };
       const runtime = defineRuntime({
         name: "fake",
         run: ({ prompt, sessionId, signal }) =>
           sessionId
             ? Promise.resolve({ text: "", sessionId, structured: prompt })
             : new Promise((_, reject) => signal.addEventListener("abort", () => reject(new InterruptedError("s1", signal.reason)))),
       });
       export default Flow.start("f").then(agentNode("research", { prompt: () => "count", output }, runtime)).build();`,
    );
    const store = ["--store", dir];
    const started = async (runId: string) => {
      const events = () => readFile(join(dir, runId, "events.jsonl"), "utf8").catch(() => "");
      while (!(await events()).includes('"start","node":"research"')) await new Promise((r) => setTimeout(r, 20));
    };

    const one = cli("run", file, "--run-id", "a", ...store);
    await started("a");
    expect((await cli("stop", "a", "research", ...store)).stdout).toContain("to stop and answer");
    expect(JSON.parse((await one).stdout)).toMatchObject({
      status: "done",
      output: expect.stringContaining("Stop working now"),
    });
    expect(await cli("stop", "a", ...store)).toMatchObject({ code: 1, stderr: expect.stringContaining("has ended") });

    const whole = cli("run", file, "--run-id", "b", ...store);
    await started("b");
    expect((await cli("stop", "b", ...store)).stdout).toContain("Told run b to stop");
    const failed = (await whole) as { code: number; stdout: string };
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "failed", error: expect.stringContaining("stopped") });
  });
});
