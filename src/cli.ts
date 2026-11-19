#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { toGraph } from "./graph.ts";
import { toMermaid } from "./mermaid.ts";
import type { Node } from "./node.ts";
import { run } from "./run.ts";
import { FsStore } from "./store.ts";

const USAGE = `ayaito run <flow file> [--run-id <id>] [--store <dir>] [--input <json> | --input-file <path>]
  Runs the flow the file exports as default, and saves the run under <store>/<run id>/:
  events.jsonl, graph.json and, when it ends, result.json. Running the same run id again resumes it.
  Without --input, the input is the file's export named input.

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
  const [command, file] = positionals;
  if (values.help || !file || (command !== "run" && command !== "graph")) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
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

  let result: Record<string, unknown>;
  try {
    const { events: _events, ...rest } = await run(flow, (text === undefined ? input : JSON.parse(text)) as never, {
      runId,
      store,
      signal: abort.signal,
    });
    result = rest;
  } catch (error) {
    result = { status: "failed", error: error instanceof Error ? (error.stack ?? String(error)) : String(error) };
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
