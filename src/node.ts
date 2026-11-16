/** A step of work: what a node does with its input. */
export type Fn<I, O> = (input: I, ctx: Context) => Promise<O>;

/** A named step. Nodes compose into flows, and a built flow is a node again. */
export interface Node<I, O> {
  readonly name: string;
  readonly run: Fn<I, O>;
}

/** What a run records about its nodes, in order. */
export type RunEvent =
  | { type: "start"; node: string; at: string }
  | { type: "end"; node: string; at: string; ms: number }
  | { type: "skip"; node: string; at: string; reason: string }
  | { type: "retry"; node: string; at: string; attempt: number; error: string }
  | { type: "error"; node: string; at: string; error: string }
  | { type: "usage"; node: string; at: string; usd: number; models: Record<string, Tokens> };

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
  return { name, run };
}
