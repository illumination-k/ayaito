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
});
