import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";

import type { Started } from "../types";

export const RUN = "mcp__ayaito__run";
export const STOP = "mcp__ayaito__stop";
export const STEER = "mcp__ayaito__steer";

/** What Claude reads of a result or a log: the rest is in the run's folder. */
const SHOWN = 8000;

const started = atom({ plugin: "ayaito", key: "started" } as const, [], { shape: "started-1" });

export const RUN_SPEC = {
  name: "run",
  isDeferred: false,
  description: `Runs a workflow of agents and code that you write, in the background, with ayaito (a typed graph engine). Use it when the user asks for an ayaito flow or workflow, or for work to be orchestrated across several agents. The call returns at once with a run id; a pane shows the run on its graph, and a message reaches you when it ends, so do not poll or wait for it.

\`script\` is a TypeScript module (types are stripped, not checked) whose default export is a built flow. Annotate the input of every function. Example:

import { z } from "zod";
import { agentNode, assign, branch, checkpoint, exec, fnNode, Flow, forEach, parallel, retry, Stop, until, worktree } from "ayaito";
import { claudeRuntime } from "ayaito/claude";

const claude = claudeRuntime();
type In = { goal: string };
const plan = agentNode("plan", { prompt: (s: In) => \`List the tasks for: \${s.goal}\`, output: z.object({ tasks: z.array(z.string()) }), access: "read-only" }, claude);
const fix = agentNode("fix", { prompt: (task: string) => task, output: z.object({ summary: z.string() }), access: "write" }, claude);
const test = fnNode("test", async (fixes: unknown[], ctx) => ({ fixes, code: (await exec("npm", ["test"], { cwd: ctx.cwd })).code }));

export const input: In = { goal: "..." };
export default Flow.start<In>("fix-all")
  .then(assign("plan", plan), { use: [checkpoint] })               // state becomes In & { plan }
  .then(forEach("fix each", worktree(fix, { commit: (o) => o.summary }), { concurrency: 3, use: [checkpoint] }), { map: (s) => s.plan.tasks })
  .then(test)
  .build();

Parts: fnNode(name, async (input, ctx) => output) is code; agentNode(name, { prompt, output (a zod schema), access: "read-only" | "write", model?, system? }, runtime) is an agent whose answer is validated. .then(node, { map, use }): map turns the previous output into the node's input and is required when the types differ; use is middleware: checkpoint (skip on resume), retry({ attempts }), timeout(ms), budget({ usd }). assign(key, node) adds the output to the state. parallel(name, { key: node, ... }) runs nodes on one input and returns { key: output }; a failed node aborts the others, unless { failFast: false } is passed (all finish, then it throws an AggregateError). forEach(name, node, { concurrency, failFast }) runs a node per item of a list; failFast: false works as in parallel. branch(name, (input) => key, { key: node, ... }) picks one node. until(name, node, (output) => done, max) repeats a node whose input and output have one type. worktree(node, { commit: message }) gives an agent that writes its own git worktree and branch; its output is { output, branch, path, commit }, so agents can write side by side. throw new Stop(reason) ends the run early as a success. Node names must be unique: events are matched to nodes by name.

To run a saved flow again from its checkpoints, pass its \`runId\` (with a new \`script\` to change the flow, or without one to reuse it).`,
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "A short name for the run, as kebab-case words: the run id starts with it.",
      },
      script: { type: "string", description: "The TypeScript module whose default export is the built flow." },
      input: { description: "The flow's input, as JSON. Absent, the script's export named input." },
      runId: { type: "string", description: "The id of an earlier run to resume from its checkpoints." },
    },
  },
} as const;

export const STOP_SPEC = {
  name: "stop",
  description:
    "Stops a run that the ayaito run tool started. Its checkpoints stay, so the run can be resumed by its id. With `node`, stops only the agent of that node, which must be running: it is interrupted and answers from what it has done so far, and the run goes on with that answer. Use it for an agent that has done enough or is stuck.",
  inputSchema: {
    type: "object",
    required: ["runId"],
    properties: {
      runId: { type: "string" },
      node: {
        type: "string",
        description: "To stop only an agent: its node's name, name#item in a forEach, or its session id.",
      },
    },
  },
} as const;

export const STEER_SPEC = {
  name: "steer",
  description:
    "Sends a message to an agent of a run while it works: its turn is interrupted, it reads the message and goes on with its task. Use it to correct or redirect an agent that is going wrong, without stopping the run. `node` is the name of an agent node that is running now; in a forEach, where one node has an agent per item, `name#item` (fix#2) reaches the agent of that item and the bare name all of them; the id of an agent's session reaches that agent too. To see what the agents are doing, read the end of <runs dir>/<runId>/events.jsonl: its session lines have each agent's session id, its activity lines what each agent said and the tools it called (with `item` inside a forEach), and a steer line appears when the agent got the message.",
  inputSchema: {
    type: "object",
    required: ["runId", "node", "message"],
    properties: {
      runId: { type: "string" },
      node: { type: "string", description: "The agent node's name, name#item in a forEach, or a session id." },
      message: { type: "string", description: "What to tell the agent." },
    },
  },
} as const;

/** How to start ayaito's CLI here: the project's own, or ayaito's repository itself. */
async function cli($: EngineInterface): Promise<string[] | undefined> {
  if (await $.fs.exists("node_modules/.bin/ayaito")) return ["node_modules/.bin/ayaito"];
  const own = await $.fs.read("package.json").catch(() => "{}");
  const isAyaito = (JSON.parse(own) as { name?: string }).name === "ayaito";
  return isAyaito && (await $.fs.exists("dist/cli.mjs")) ? ["node", "dist/cli.mjs"] : undefined;
}

const cut = (text: string) =>
  text.length > SHOWN ? `${text.slice(0, SHOWN)}\n… (cut; the whole is in the file)` : text;
const tail = (text: string) => (text.length > SHOWN ? `…\n${text.slice(-SHOWN)}` : text);

/** Starts a run as a process of its own, which goes on when the mod reloads, and answers with its id. */
export async function start(
  $: EngineInterface,
  dir: string,
  e: { name?: unknown; script?: unknown; input?: unknown; runId?: unknown },
): Promise<{ result: string } | { deny: string }> {
  const command = await cli($);
  if (!command)
    return {
      deny: "ayaito is not installed in this project: npm install ayaito zod (and the SDK of the agents' runtime).",
    };
  const name = typeof e.name === "string" && e.name !== "" ? e.name : "flow";
  const stamp = (await $.clock.now()).toString(36);
  const runId =
    typeof e.runId === "string" && e.runId !== "" ? e.runId : `${name.replaceAll(/[^\w.-]+/g, "-")}-${stamp}`;
  if (/[\\/]/.test(runId) || runId.startsWith(".")) return { deny: `${runId} is not a run id.` };
  const base = `${dir}/${runId}`;
  if ((await read($, started)).some((run) => run.runId === runId && run.dir === dir)) {
    return { deny: `Run ${runId} is still going. Stop it first, or wait for its end.` };
  }

  if (typeof e.script === "string" && e.script.trim() !== "") await $.fs.write(`${base}/flow.ts`, e.script);
  else if (!(await $.fs.exists(`${base}/flow.ts`))) {
    return {
      deny:
        typeof e.runId === "string" ? `No saved flow for run ${runId}: pass script.` : "Pass script: the flow to run.",
    };
  }
  const argv = [...command, "run", `${base}/flow.ts`, "--run-id", runId, "--store", dir];
  if (e.input !== undefined) {
    await $.fs.write(`${base}/input.json`, JSON.stringify(e.input));
    argv.push("--input-file", `${base}/input.json`);
  }
  // An earlier attempt's end is not this one's.
  await $.fs.write(`${base}/result.json`, "");
  // The shell starts it and leaves: the run is no child of the mod, whose reload would end it.
  const shell = 'nohup "$@" > "$0" 2>&1 & echo $!';
  const { exitCode, stdout, stderr } = await $.process.run(["sh", "-c", shell, `${base}/run.log`, ...argv]);
  const pid = Number.parseInt(stdout.trim(), 10);
  if (exitCode !== 0 || !Number.isInteger(pid))
    return { deny: `The run did not start: ${stderr.trim() || stdout.trim()}` };
  await update($, started, (runs) => [...runs, { runId, dir, pid }]);

  return {
    result: `Started run ${runId} in the background (${base}/). The ayaito pane shows it on its graph, and a message will reach you when it ends: do not poll or wait. Tell the user it is running.`,
  };
}

export async function stop(
  $: EngineInterface,
  dir: string,
  { runId, node }: { runId?: unknown; node?: unknown },
): Promise<{ result: string } | { deny: string }> {
  if (typeof node === "string" && node !== "") {
    const command = await cli($);
    if (!command) return { deny: "ayaito is not installed in this project." };
    if (typeof runId !== "string") return { deny: "Pass runId." };
    const { exitCode, stdout, stderr } = await $.process.run([...command, "stop", "--store", dir, "--", runId, node]);

    return exitCode === 0 ? { result: stdout.trim() } : { deny: stderr.trim() || stdout.trim() };
  }
  const run = (await read($, started)).find((one) => one.runId === runId);
  if (!run) return { deny: `No run ${String(runId)} is going that this tool started.` };
  await update($, started, (runs) => runs.filter((one) => one !== run && one.runId !== run.runId));
  await $.process.run(["kill", String(run.pid)]);

  return { result: `Stopped run ${run.runId}. Resume it by passing its runId to the run tool.` };
}

/** Leaves a message for an agent of a run, through the CLI, which knows whether the node is at work. */
export async function steer(
  $: EngineInterface,
  dir: string,
  e: { runId?: unknown; node?: unknown; message?: unknown },
): Promise<{ result: string } | { deny: string }> {
  const command = await cli($);
  if (!command) return { deny: "ayaito is not installed in this project." };
  const { runId, node, message } = e;
  if (typeof runId !== "string" || typeof node !== "string" || typeof message !== "string" || message.trim() === "") {
    return { deny: "Pass runId, node and message." };
  }
  const argv = [...command, "steer", "--store", dir, "--", runId, node, message];
  const { exitCode, stdout, stderr } = await $.process.run(argv);

  return exitCode === 0 ? { result: stdout.trim() } : { deny: stderr.trim() || stdout.trim() };
}

/** Tells Claude of each run that ended since the last look. */
export async function watch($: EngineInterface): Promise<void> {
  for (const run of await read($, started)) {
    const base = `${run.dir}/${run.runId}`;
    let result = await $.fs.read(`${base}/result.json`).catch(() => "");
    if (result.trim() === "") {
      const { exitCode } = await $.process.run(["kill", "-0", String(run.pid)]);
      if (exitCode === 0) continue;
      // It ended between the two looks, or without a result (the script did not load).
      result = await $.fs.read(`${base}/result.json`).catch(() => "");
    }
    // Only the look that takes the run off the list tells of it.
    let isMine = false;
    await update($, started, (runs) => {
      isMine = runs.some((one) => one.runId === run.runId && one.dir === run.dir);
      return runs.filter((one) => !(one.runId === run.runId && one.dir === run.dir));
    });
    if (!isMine) continue;
    const log = result.trim() === "" ? await $.fs.read(`${base}/run.log`).catch(() => "") : "";
    const text =
      result.trim() === ""
        ? `ayaito run ${run.runId} ended without a result. Its log (${base}/run.log):\n${tail(log) || "(empty)"}`
        : `ayaito run ${run.runId} ended. Its result (${base}/result.json; the outputs of its nodes and events.jsonl are beside it):\n${cut(result)}`;
    await $.prompt.submit({ text });
  }
}
