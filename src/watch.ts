import type { Graph, GraphNode } from "./graph.ts";
import type { RunEvent } from "./node.ts";
import { totalCost } from "./run.ts";

type Status = "pending" | "running" | "done" | "failed" | "skipped" | "stopped";

const MARK: Record<Status, string> = {
  pending: "○",
  running: "●",
  done: "✓",
  failed: "✗",
  skipped: "–",
  stopped: "■",
};

interface NodeState {
  status: Status;
  running: number;
  runs: number;
  isSkipped: boolean;
  /** When the call that is running started. */
  since?: number;
  ms?: number;
  usd: number;
  attempt?: number;
  error?: string;
  /** The last thing its agent said or did, was sent, or its code logged. */
  activity?: string;
}

/** As much of an activity as a line shows. */
const LINE = 200;
const line = (text: string) => text.replaceAll(/\s+/g, " ").trim().slice(0, LINE);

/** What the events say about each node, by its name. */
function fold(events: RunEvent[]): Map<string, NodeState> {
  const states = new Map<string, NodeState>();
  const of = (name: string) => {
    const state = states.get(name) ?? { status: "pending", running: 0, runs: 0, isSkipped: false, usd: 0 };
    states.set(name, state);
    return state;
  };
  const ended = (state: NodeState, status: Status) => {
    state.running = Math.max(0, state.running - 1);
    state.status = state.running > 0 ? "running" : status;
  };
  for (const e of events) {
    const state = of(e.node);
    // Which of a forEach's agents the line is about.
    const who = e.item === undefined ? "" : `#${e.item} `;
    switch (e.type) {
      case "start":
        state.running++;
        state.runs++;
        state.status = "running";
        state.since = Date.parse(e.at);
        state.isSkipped = false;
        state.error = undefined;
        state.activity = undefined;
        break;
      case "skip":
        state.isSkipped = true;
        break;
      case "end":
        state.ms = e.ms;
        ended(state, state.isSkipped ? "skipped" : "done");
        break;
      case "error":
        state.error = e.error;
        ended(state, "failed");
        break;
      case "retry":
        state.attempt = e.attempt;
        break;
      case "usage":
        state.usd += e.usd ?? 0;
        break;
      case "activity":
        state.activity = line(who + (e.tool === undefined ? e.text : `${e.tool} ${e.text}`));
        break;
      case "log":
        state.activity = line(who + e.text);
        break;
      case "wrapUp":
        if (e.stopped) state.activity = `${who}← stop`;
        break;
      case "steer":
        state.activity = line(`${who}← ${e.message}`);
        break;
      case "stop":
        // The flows around the node that stopped record nothing more: the run is over.
        for (const other of states.values()) {
          if (other.running > 0) Object.assign(other, { running: 0, status: "stopped" });
        }
        break;
      default:
    }
  }
  return states;
}

const time = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;

const money = (usd: number) => `$${usd.toFixed(usd < 1 ? 3 : 2)}`;

/** What a group that recorded nothing is, from its members: run records nothing for the node it was given. */
function ofMembers(members: Status[]): Status {
  const has = (status: Status) => members.includes(status);
  if (has("running")) return "running";
  if (has("failed")) return "failed";
  if (has("stopped")) return "stopped";
  if (!has("pending")) return "done";
  return has("done") || has("skipped") ? "running" : "pending";
}

/**
 * A run as text for people: its graph (toGraph, or the run's graph.json) as a tree, each node with
 * what the events say about it: whether it is waiting (○), running (●), done (✓), failed (✗), skipped
 * (–) or stopped (■), how long it took, what it cost and, while it runs, the last thing its agent did.
 * The first line counts the steps (code and agent nodes) that are done. `ayaito watch` shows a run
 * with it. now is the time that running nodes are timed against.
 */
export function formatRun(graph: Graph, events: RunEvent[], now: number = Date.now()): string {
  const states = fold(events);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // The node a case of a branch starts at: the edge leads to the first step inside it.
  const cases = new Map<string, { when: string; choice: string }>();
  for (const e of graph.edges) {
    const choice = byId.get(e.from);
    if (e.when === undefined || choice?.name === undefined) continue;
    let top = byId.get(e.to);
    while (top?.parent !== undefined && top.parent !== choice.parent) top = byId.get(top.parent);
    if (top) cases.set(top.id, { when: e.when, choice: choice.name });
  }

  const steps: Status[] = [];
  /** The lines of the nodes in parent, and what they are. */
  const draw = (parent: string | undefined, depth: number, isUntaken: boolean): { lines: string[]; all: Status[] } => {
    const lines: string[] = [];
    const all: Status[] = [];
    const pad = "  ".repeat(depth);
    for (const n of graph.nodes) {
      // The ends of the graph and the "done?" of a loop say nothing about the run.
      if (n.parent !== parent || n.kind === "input" || n.kind === "output" || n.name === undefined) continue;
      const state = states.get(n.name);
      const from = cases.get(n.id);
      // The branch chose, and not this case.
      const untaken =
        isUntaken || (from !== undefined && state === undefined && states.get(from.choice)?.status === "done");
      const isStep = n.kind === "fn" || n.kind === "agent";
      const inside = isStep || n.kind === "choice" ? undefined : draw(n.id, depth + 1, untaken);
      let status: Status = untaken ? "skipped" : (state?.status ?? "pending");
      if (status === "pending" && state === undefined && inside && inside.all.length > 0) {
        status = ofMembers(inside.all);
      }
      if (isStep && !untaken) steps.push(status);
      all.push(status);
      const detail = [
        ...about(n, graph),
        untaken && !isUntaken && "not taken",
        state && state.runs > 1 && `×${state.runs}`,
        state?.attempt !== undefined && status === "running" && `attempt ${state.attempt + 1}`,
        state?.since !== undefined && status === "running" && time(Math.max(0, now - state.since)),
        state?.ms !== undefined && status !== "running" && time(state.ms),
        state && state.usd > 0 && money(state.usd),
      ].filter(Boolean);
      const label = n.key === undefined || n.key === n.label ? n.label : `${n.key}: ${n.label}`;
      const name = `${from === undefined ? "" : `${from.when}: `}${n.kind === "choice" ? "◇ " : ""}${label}`;
      lines.push(`${pad}${MARK[status]} ${name}${detail.length > 0 ? `  ${detail.join(" · ")}` : ""}`);
      if (state?.activity !== undefined && status === "running") lines.push(`${pad}    ${state.activity}`);
      if (state?.error !== undefined && status === "failed") lines.push(`${pad}    ${line(state.error)}`);
      if (inside) lines.push(...inside.lines);
    }
    return { lines, all };
  };
  const { lines } = draw(undefined, 0, false);

  const done = steps.filter((status) => status === "done" || status === "skipped").length;
  const usd = totalCost(events);
  return [`${done}/${steps.length} steps${usd > 0 ? ` · ${money(usd)}` : ""}`, ...lines].join("\n");
}

/** What the graph says about a node, whatever the run does. */
function about(n: GraphNode, graph: Graph): (string | false | undefined)[] {
  return [
    n.assign !== undefined && `→ ${n.assign}`,
    n.worktree && "worktree",
    n.kind === "forEach" &&
      `each item${n.concurrency === undefined ? "" : `, ${n.concurrency} at a time`}${n.failFast === false ? ", all finish" : ""}`,
    n.kind === "until" && `at most ${n.max}`,
    n.kind === "parallel" && (n.failFast === false ? "parallel, all finish" : "parallel"),
    ...new Set(graph.edges.filter((e) => e.to === n.id).flatMap((e) => e.use ?? [])),
  ];
}
