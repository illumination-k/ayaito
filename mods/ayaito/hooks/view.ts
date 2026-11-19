import type { Row, Status, View } from "../types";

/** ayaito's toGraph, as far as the pane reads it. */
export type Graph = {
  nodes: {
    id: string;
    kind: string;
    label: string;
    name?: string;
    parent?: string;
    assign?: string;
    worktree?: true;
    key?: string;
    concurrency?: number;
    max?: number;
  }[];
  edges: { from: string; to: string; when?: string; map?: true; use?: string[] }[];
};

/** A line of ayaito's events.jsonl. */
export type RunEvent = {
  type: "start" | "end" | "skip" | "retry" | "error" | "stop" | "wrapUp" | "usage" | "activity" | "steer" | "session";
  node: string;
  /** Inside a forEach: the index of the item the event is for. */
  item?: string;
  ms?: number;
  attempt?: number;
  error?: string;
  usd?: number;
  tool?: string;
  text?: string;
  message?: string;
  stopped?: boolean;
};

/** As much of an activity as a line of the pane can show. */
const LINE = 200;
const line = (text: string) => text.replaceAll(/\s+/g, " ").trim().slice(0, LINE);

type NodeState = {
  status: Status;
  running: number;
  runs: number;
  isSkipped: boolean;
  ms?: number;
  usd: number;
  attempt?: number;
  error?: string;
  /** The last thing its agent said or did, or was sent. */
  activity?: string;
};

/** What the events say about each node, by its name. */
export function fold(events: RunEvent[]): Map<string, NodeState> {
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
        state.activity = line(who + (e.tool === undefined ? (e.text ?? "") : `${e.tool} ${e.text ?? ""}`));
        break;
      case "wrapUp":
        if (e.stopped) state.activity = `${who}← stop`;
        break;
      case "steer":
        state.activity = line(`${who}← ${e.message ?? ""}`);
        break;
      case "stop":
        // The flows around the node that stopped record nothing more: the run is over.
        for (const other of states.values()) {
          if (other.running > 0) Object.assign(other, { running: 0, status: "stopped" });
        }
        break;
    }
  }
  return states;
}

/** Parses events.jsonl, leaving out a line cut short (a write in progress, or the start of a range). */
export function parseEvents(text: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {}
  }
  return events;
}

const time = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;

export const money = (usd: number) => `$${usd.toFixed(usd < 1 ? 3 : 2)}`;

/** The graph as the lines of the pane, each node with what the events say about it. */
export function view(dir: string, runId: string, graph: Graph, events: RunEvent[]): View {
  const states = fold(events);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const rows: (Row & { parent?: string; isStep: boolean })[] = [];

  // The node a case of a branch starts at: the edge leads to the first step inside it.
  const cases = new Map<string, { when: string; choice: string }>();
  for (const e of graph.edges) {
    const choice = byId.get(e.from);
    if (e.when === undefined || choice?.name === undefined) continue;
    let top = byId.get(e.to);
    while (top?.parent !== undefined && top.parent !== choice.parent) top = byId.get(top.parent);
    if (top) cases.set(top.id, { when: e.when, choice: choice.name });
  }

  const draw = (parent: string | undefined, depth: number, isUntaken: boolean) => {
    for (const n of graph.nodes) {
      // The ends of the graph and the "done?" of a loop say nothing about the run.
      if (n.parent !== parent || n.kind === "input" || n.kind === "output" || n.name === undefined) continue;
      const state = states.get(n.name);
      const from = cases.get(n.id);
      // The branch chose, and not this case.
      const untaken =
        isUntaken || (from !== undefined && state === undefined && states.get(from.choice)?.status === "done");
      const status = untaken ? "skipped" : (state?.status ?? "pending");
      const detail = [
        n.assign !== undefined && `→ ${n.assign}`,
        n.worktree && "worktree",
        n.kind === "forEach" && `each item${n.concurrency === undefined ? "" : `, ${n.concurrency} at a time`}`,
        n.kind === "until" && `at most ${n.max}`,
        n.kind === "parallel" && "parallel",
        ...new Set(graph.edges.filter((e) => e.to === n.id).flatMap((e) => e.use ?? [])),
        untaken && !isUntaken && "not taken",
        state && state.runs > 1 && `×${state.runs}`,
        state?.attempt !== undefined && status === "running" && `attempt ${state.attempt + 1}`,
        state?.ms !== undefined && status !== "running" && time(state.ms),
        state && state.usd > 0 && money(state.usd),
      ]
        .filter(Boolean)
        .join(" · ");
      const isStep = n.kind === "fn" || n.kind === "agent";
      rows.push({
        id: n.id,
        depth,
        kind: n.kind,
        label: n.key === undefined || n.key === n.label ? n.label : `${n.key}: ${n.label}`,
        ...(from !== undefined && { when: from.when }),
        status,
        detail,
        ...(state?.error !== undefined && status === "failed" && { error: state.error }),
        ...(state?.activity !== undefined && status === "running" && { activity: state.activity }),
        ...(parent !== undefined && { parent }),
        isStep: isStep && !untaken,
      });
      if (!isStep && n.kind !== "choice") draw(n.id, depth + 1, untaken);
    }
  };
  draw(undefined, 0, false);

  // run records nothing for the node it was given: a group without events is as far as its members are.
  for (const row of rows.toReversed()) {
    const name = byId.get(row.id)?.name;
    if (row.status !== "pending" || (name !== undefined && states.has(name))) continue;
    const members = rows.filter((r) => r.parent === row.id).map((r) => r.status);
    if (members.length === 0) continue;
    const has = (status: Status) => members.includes(status);
    row.status = has("running")
      ? "running"
      : has("failed")
        ? "failed"
        : has("stopped")
          ? "stopped"
          : !has("pending")
            ? "done"
            : has("done") || has("skipped")
              ? "running"
              : "pending";
  }

  let usd = 0;
  for (const e of events) if (e.type === "usage") usd += e.usd ?? 0;
  const steps = rows.filter((row) => row.isStep);
  return {
    dir,
    runId,
    rows: rows.map(({ parent: _parent, isStep: _isStep, ...row }) => row),
    done: steps.filter((row) => row.status === "done" || row.status === "skipped").length,
    total: steps.length,
    usd,
  };
}
