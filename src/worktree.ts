import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { exec } from "./exec.ts";
import type { Context, Node } from "./node.ts";

export interface WorktreeOptions<I, O> {
  /** The repository. Defaults to the context's cwd, then the process's working directory. */
  repo?: string;
  /** What a new branch starts from. Defaults to the repository's HEAD. */
  base?: string;
  /** Defaults to `ayaito/<runId>/<node>-<hash of the input>`, so that each input gets its own. */
  branch?: (input: I, ctx: Context) => string;
  /** Where the worktree goes. Defaults to a directory named after the branch in the system's temp directory. */
  path?: (branch: string) => string;
  /** Commits whatever the node changed (agents often leave changes uncommitted), with this message. */
  commit?: string | ((output: O, input: I) => string);
  /**
   * Removes the worktree after the node succeeds; the branch stays. git refuses while there
   * are uncommitted changes, so use it with commit.
   */
  remove?: boolean;
}

/** The node's output, and where its changes are. */
export interface InWorktree<O> {
  output: O;
  branch: string;
  path: string;
  /** The commit that commit made, absent when the node changed nothing (or commit was not set). */
  commit?: string;
}

/**
 * Runs node in a git worktree of its own, on its own branch, so that agents that write can
 * run side by side (forEach, parallel) without touching each other's files or the main
 * checkout. The node sees the worktree as ctx.cwd, which agent nodes without a cwd use.
 * Running the same input again (a resumed run) reuses the branch and the worktree.
 */
export function worktree<I, O>(node: Node<I, O>, opts: WorktreeOptions<I, O> = {}): Node<I, InWorktree<O>> {
  return {
    name: node.name,
    shape: { kind: "worktree", node },
    run: async (input, ctx) => {
      const repo = resolve(opts.repo ?? ctx.cwd ?? process.cwd());
      const branch = opts.branch?.(input, ctx) ?? defaultBranch(node.name, input, ctx.runId);
      const path = resolve(opts.path?.(branch) ?? join(tmpdir(), "ayaito-worktrees", slug(branch)));
      await serial(repo, () => add(repo, branch, path, opts.base, ctx.signal));

      const output = await node.run(input, { ...ctx, cwd: path });

      let commit: string | undefined;
      if (opts.commit !== undefined) {
        const message = typeof opts.commit === "string" ? opts.commit : opts.commit(output, input);
        await git(path, ["add", "--all"], ctx.signal);
        const staged = await exec("git", ["diff", "--cached", "--quiet"], { cwd: path, signal: ctx.signal });
        if (staged.code !== 0) {
          await git(path, ["commit", "--quiet", "--message", message], ctx.signal);
          commit = await git(path, ["rev-parse", "HEAD"], ctx.signal);
        }
      }
      if (opts.remove) await serial(repo, () => git(repo, ["worktree", "remove", path], ctx.signal));
      return commit === undefined ? { output, branch, path } : { output, branch, path, commit };
    },
  };
}

/** Adds the worktree, or reuses the one a previous run left on the same branch. */
async function add(repo: string, branch: string, path: string, base: string | undefined, signal: AbortSignal) {
  if (existsSync(path)) {
    const head = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, signal });
    if (head.code === 0 && head.stdout.trim() === branch) return;
    throw new Error(`worktree: ${path} exists and is not a worktree on ${branch}`);
  }
  // Forgets worktrees whose directory is gone (a cleared temp directory), which would block the branch.
  await git(repo, ["worktree", "prune"], signal);
  const exists = await exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, signal });
  await git(
    repo,
    exists.code === 0
      ? ["worktree", "add", "--quiet", path, branch]
      : ["worktree", "add", "--quiet", "-b", branch, path, ...(base === undefined ? [] : [base])],
    signal,
  );
}

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  const { code, stdout, stderr } = await exec("git", args, { cwd, signal });
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.trim() || `exit ${code}`}`);
  return stdout.trim();
}

// git locks the repository's worktree list and refs, so parallel nodes add and remove one at a time.
const queues = new Map<string, Promise<unknown>>();

function serial<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const result = (queues.get(repo) ?? Promise.resolve()).then(fn, fn);
  queues.set(
    repo,
    result.catch(() => {}),
  );
  return result;
}

function defaultBranch(name: string, input: unknown, runId: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(input) ?? "undefined")
    .digest("hex")
    .slice(0, 8);
  return `ayaito/${slug(runId)}/${slug(name)}-${hash}`;
}

/** A name git and file systems both take: letters, digits, dots, dashes and underscores. */
function slug(text: string): string {
  return (
    text
      .replace(/[^\w.-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .replace(/\.{2,}/g, ".") || "x"
  );
}
