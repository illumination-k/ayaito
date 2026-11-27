import type { Steer } from "./steer.ts";

/** A step of work: what a node does with its input. */
export type Fn<I, O> = (input: I, ctx: Context) => Promise<O>;

/** A named step. Nodes compose into flows, and a built flow is a node again. */
export interface Node<I, O> {
  readonly name: string;
  readonly run: Fn<I, O>;
  /** How the node is built, for drawing it (toGraph, toMermaid). A node without one is drawn as code. */
  readonly shape?: Shape;
}

/** What toGraph describes: the parts a node is built from. */
export type Shape =
  | { kind: "fn" }
  | { kind: "agent" }
  | { kind: "flow"; steps: Step[] }
  | { kind: "parallel"; branches: Record<string, Node<never, unknown>>; failFast?: false; use: string[] }
  | { kind: "until"; body: Node<never, unknown>; max: number }
  | { kind: "assign"; key: string; node: Node<never, unknown> }
  | { kind: "branch"; cases: Record<string, Node<never, unknown>> }
  | { kind: "forEach"; body: Node<never, unknown>; concurrency?: number; failFast?: false; use: string[] }
  | { kind: "worktree"; node: Node<never, unknown> };

/** A node of a flow and the edge into it: whether it maps, and the names of its middleware. */
export interface Step {
  node: Node<never, unknown>;
  map: boolean;
  use: string[];
}

/**
 * What a run records about its nodes, in order. item is set for what happens inside forEach:
 * the index of the item it is for ("2"; inside a forEach in a forEach, "0.2").
 */
export type RunEvent = { item?: string } & NodeEvent;

type NodeEvent =
  | { type: "start"; node: string; at: string }
  | { type: "end"; node: string; at: string; ms: number }
  | { type: "skip"; node: string; at: string; reason: string }
  | { type: "retry"; node: string; at: string; attempt: number; error: string }
  | { type: "error"; node: string; at: string; error: string }
  | { type: "stop"; node: string; at: string; reason: string }
  /**
   * The agent's turn was interrupted and it was asked to answer: time was up (timeout's wrapUp),
   * or with stopped, it was told to stop (steer's stop).
   */
  | { type: "wrapUp"; node: string; at: string; stopped?: true }
  /** An agent's call runs in this session: resume it to go on from its work, or send it a message by this id. */
  | { type: "session"; node: string; at: string; sessionId: string }
  /** What an agent said, or with tool, a tool it called and the input in short. */
  | { type: "activity"; node: string; at: string; tool?: string; text: string }
  /** A message sent to the agent while it worked (run's steer) reached its session. */
  | { type: "steer"; node: string; at: string; message: string }
  /** usd is absent when the runtime reports tokens only (codex). */
  | { type: "usage"; node: string; at: string; usd?: number; models: Record<string, Tokens> };

/** Tokens one model used in an agent call. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Distributes RunEvent without its `at`, which emit stamps. */
export type NewRunEvent = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at"> : never) : never;

/** Shared by every node of one run. */
export interface Context {
  readonly runId: string;
  readonly store: Store;
  readonly emit: (event: NewRunEvent) => void;
  /** Every event of the run so far, including earlier attempts of a resumed run. */
  readonly history: () => Promise<RunEvent[]>;
  /** Aborted when the run is cancelled, or when a sibling in parallel fails. */
  readonly signal: AbortSignal;
  /**
   * The directory nodes work in, when one is set: run's cwd, or the worktree of a node
   * inside worktree. Agent nodes without a cwd of their own run there.
   */
  readonly cwd?: string;
  /**
   * Set inside timeout with wrapUp. When signal aborts, an agent node interrupts its current
   * turn and asks the same session for its answer with prompt, instead of being cut off.
   */
  readonly wrapUp?: { readonly signal: AbortSignal; readonly prompt: string };
  /** Inside forEach: the index of the item this node runs for ("2"; nested, "0.2"). */
  readonly item?: string;
  /** run's steer: agent nodes listen to it for messages sent to them while they work. */
  readonly steer?: Steer;
}

/**
 * Ends a run early as a success: a node that finds nothing to do throws it, so that nothing
 * after it starts. run returns status "stopped" with the node and the reason.
 */
export class Stop extends Error {
  override name = "Stop";
  /** The node that threw it, set by the flow that runs the node. */
  node?: string;
}

/** Keeps the outputs and events of runs, so that a run can be resumed. */
export interface Store {
  get(runId: string, key: string): Promise<unknown>;
  put(runId: string, key: string, value: unknown): Promise<void>;
  /** Forgets the outputs whose key starts with prefix, so those nodes run again. */
  invalidate(runId: string, prefix: string): Promise<number>;
  append(runId: string, event: RunEvent): Promise<void>;
  events(runId: string): Promise<RunEvent[]>;
}

/** A node that runs code: deterministic steps such as builds, git, and pull requests. */
export function fnNode<I, O>(name: string, run: Fn<I, O>): Node<I, O> {
  return { name, run, shape: { kind: "fn" } };
}
