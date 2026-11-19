#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { toGraph } from "./graph.ts";
import { toMermaid } from "./mermaid.ts";
import type { Node } from "./node.ts";
import { run } from "./run.ts";
import { steering } from "./steer.ts";
import { FsStore } from "./store.ts";

const USAGE = `ayaito run <flow file> [--run-id <id>] [--store <dir>] [--input <json> | --input-file <path>]
  Runs the flow the file exports as default, and saves the run under <store>/<run id>/:
  events.jsonl, graph.json and, when it ends, result.json. Running the same run id again resumes it.
  Without --input, the input is the file's export named input.

ayaito steer <run id> <node> <message> [--store <dir>]
  Sends a message to the agent of a node of a run that \`ayaito run\` is running: its turn is interrupted,
  it reads the message and goes on with its task. What the agents do is in the run's events.jsonl.

ayaito graph <flow file> [--mermaid]
  Prints the flow as JSON (toGraph), or as a Mermaid flowchart.`;

interface FlowModule {
  default?: unknown;
  input?: unknown;
}

function isNode(value: unknown): value is Node<never, unknown> {
  const node = value as Partial<Node<never, unknown>> | null;
  return typeof node?.name === "string" && typeof node.run === "function";
}

async function load(file: string): Promise<{ flow: Node<never, unknown>; input: unknown }> {
  const module = (await import(pathToFileURL(resolve(file)).href)) as FlowModule;
  if (!isNode(module.default)) throw new Error(`${file}: the default export is not a node (a built flow)`);
  return { flow: module.default, input: module.input };
}

// How often a run looks for messages sent to it.
const STEER_POLL_MS = 500;
const steerFile = (store: FsStore, runId: string) => join(store.dir, runId, "steer.jsonl");

/** Calls send with each message added to the file from now on (by `ayaito steer`); returns how to stop. */
async function follow(file: string, send: (node: string, message: string) => void): Promise<() => void> {
  const read = () => readFile(file).catch(() => Buffer.alloc(0));
  // What is there was sent to an earlier attempt of the run.
  let offset = (await read()).length;
  let isReading = false;
  const timer = setInterval(() => {
    if (isReading) return;
    isReading = true;
    void read()
      .then((all) => {
        const end = all.lastIndexOf("\n") + 1;
        if (end <= offset) return;
        const lines = all.subarray(offset, end).toString("utf8").split("\n").filter(Boolean);
        offset = end;
        for (const line of lines) {
          const { node, message } = JSON.parse(line) as { node: string; message: string };
          send(node, message);
        }
      })
      .catch((error: unknown) => console.error(`steer: ${String(error)}`))
      .finally(() => (isReading = false));
  }, STEER_POLL_MS);
  return () => clearInterval(timer);
}

/** Leaves a message for the run to pick up, when an agent of the node is there to take it. */
async function steer(store: FsStore, runId: string, node: string, message: string): Promise<number> {
  const graph = (await store.get(runId, "graph")) as { nodes: { name?: string; kind: string }[] } | undefined;
  if (!graph) throw new Error(`No run ${runId} in ${store.dir}.`);
  const agents = graph.nodes.filter((n) => n.kind === "agent").map((n) => n.name);
  if (!agents.includes(node)) {
    throw new Error(`Run ${runId} has no agent node "${node}". Its agent nodes: ${agents.join(", ") || "none"}.`);
  }
  let running = 0;
  for (const e of await store.events(runId)) {
    if (e.node !== node) continue;
    if (e.type === "start") running++;
    else if (e.type === "end" || e.type === "error") running--;
  }
  if (running <= 0) throw new Error(`"${node}" is not running in run ${runId}: a message reaches an agent at work.`);
  await appendFile(steerFile(store, runId), `${JSON.stringify({ node, message })}\n`);
  console.log(`Sent to "${node}" of run ${runId}. A steer event in its events.jsonl tells when the agent got it.`);
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "run-id": { type: "string" },
      store: { type: "string", default: ".runs" },
      input: { type: "string" },
      "input-file": { type: "string" },
      mermaid: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, file, node, ...words] = positionals;
  const isSteer = command === "steer" && node !== undefined && words.length > 0;
  if (values.help || !file || (command !== "run" && command !== "graph" && !isSteer)) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  if (isSteer) return steer(new FsStore(values.store), file, node, words.join(" "));
  const { flow, input } = await load(file);

  if (command === "graph") {
    console.log(values.mermaid ? toMermaid(flow) : JSON.stringify(toGraph(flow), null, 2));
    return 0;
  }

  const text = values["input-file"] === undefined ? values.input : await readFile(values["input-file"], "utf8");
  const runId = values["run-id"] ?? `${flow.name.replaceAll(/[^\w.-]+/g, "-")}-${Date.now().toString(36)}`;
  const store = new FsStore(values.store);
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort(new Error(signal)));

  const steered = steering();
  const unfollow = await follow(steerFile(store, runId), (to, message) => {
    if (!steered.send(to, message)) console.error(`steer: no agent of "${to}" is working; dropped: ${message}`);
  });
  let result: Record<string, unknown>;
  try {
    const { events: _events, ...rest } = await run(flow, (text === undefined ? input : JSON.parse(text)) as never, {
      runId,
      store,
      signal: abort.signal,
      steer: steered,
    });
    result = rest;
  } catch (error) {
    result = { status: "failed", error: error instanceof Error ? (error.stack ?? String(error)) : String(error) };
  } finally {
    unfollow();
  }
  // What a tool that started the run reads when the process has ended.
  await store.put(runId, "result", { runId, ...result });
  console.log(JSON.stringify({ runId, ...result }, null, 2));
  return result.status === "failed" ? 1 : 0;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
