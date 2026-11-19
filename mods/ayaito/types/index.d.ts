/** Where the runs are, and the run to show: absent, the one that last wrote an event. */
export type Source = { dir: string; runId?: string };

export type Status = "pending" | "running" | "done" | "failed" | "skipped" | "stopped";

/** One line of the pane: a node of the graph, under the groups it is in. */
export type Row = {
  id: string;
  depth: number;
  kind: string;
  label: string;
  /** The case of the branch that leads here. */
  when?: string;
  status: Status;
  /** What wraps the node and what the run says about it, shown dim. */
  detail: string;
  error?: string;
};

export type View = {
  dir: string;
  runId?: string;
  rows: Row[];
  /** Steps (code and agents) that ended or were skipped, of all of them. */
  done: number;
  total: number;
  usd: number;
  /** Why there is nothing to show. */
  note?: string;
};

declare module "claude-code" {
  interface PluginState {
    ayaito: { source: Shaped<Source>; view: Shaped<View> };
  }
}
