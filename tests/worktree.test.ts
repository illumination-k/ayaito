import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { agentNode, defineRuntime, exec, fnNode, forEach, FsStore, run, worktree } from "../src/index.ts";

async function git(cwd: string, ...args: string[]) {
  const { code, stdout, stderr } = await exec("git", args, { cwd });
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "ayaito-repo-"));
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "README.md"), "base\n");
  await git(dir, "add", "--all");
  await git(dir, "commit", "--quiet", "--message", "base");
  return { dir, trees: await mkdtemp(join(tmpdir(), "ayaito-trees-")) };
}

const tmpStore = async () => new FsStore(await mkdtemp(join(tmpdir(), "ayaito-")));

describe("worktree", () => {
  it("runs each item in a worktree on its own branch and commits what it changed", async () => {
    const { dir, trees } = await repo();
    const write = fnNode("write", async (name: string, ctx) => {
      await writeFile(join(ctx.cwd!, `${name}.txt`), name);
      return name.toUpperCase();
    });
    const each = forEach(
      "each",
      worktree(write, { path: (branch) => join(trees, branch.replaceAll("/", "-")), commit: (out) => `add ${out}` }),
      { concurrency: 2 },
    );

    const { output } = await run(each, ["a", "b", "c"], { runId: "r1", store: await tmpStore(), cwd: dir });

    expect(output?.map((o) => o.output)).toEqual(["A", "B", "C"]);
    for (const o of output ?? []) {
      expect(o.branch).toMatch(/^ayaito\/r1\/write-[0-9a-f]{8}$/);
      expect(await git(dir, "log", "-1", "--format=%s", o.branch)).toBe(`add ${o.output}`);
      expect(o.commit).toBe(await git(dir, "rev-parse", o.branch));
    }
    // The main checkout is untouched.
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
    expect(await git(dir, "status", "--porcelain")).toBe("");

    // Running again reuses the worktrees; nothing new to commit.
    const again = await run(each, ["a"], { runId: "r1", store: await tmpStore(), cwd: dir });
    expect(again.output?.[0]?.branch).toBe(output?.[0]?.branch);
    expect(again.output?.[0]).not.toHaveProperty("commit");
  });

  it("gives agents the worktree as cwd, and removes it when asked", async () => {
    const { dir, trees } = await repo();
    const cwds: (string | undefined)[] = [];
    const runtime = defineRuntime({
      name: "fake",
      async run(request) {
        cwds.push(request.cwd);
        await writeFile(join(request.cwd!, "fix.txt"), "fixed");
        return { text: "", sessionId: "s", structured: "ok" };
      },
    });
    const fix = worktree(agentNode("fix", { prompt: () => "fix", output: z.string(), access: "write" }, runtime), {
      repo: dir,
      branch: () => "fix/one",
      path: () => join(trees, "one"),
      commit: "fix",
      remove: true,
    });

    const { output } = await run(fix, undefined, { runId: "r", store: await tmpStore() });

    expect(cwds).toEqual([join(trees, "one")]);
    expect(output).toMatchObject({ output: "ok", branch: "fix/one" });
    expect(existsSync(join(trees, "one"))).toBe(false);
    expect(await git(dir, "show", "fix/one:fix.txt")).toBe("fixed");
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("base\n");
  });
});
