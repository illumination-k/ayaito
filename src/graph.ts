import type { Node } from "./node.ts";

/**
 * A node (usually a built flow) as plain data, for tools that draw or inspect it: JSON that
 * survives `JSON.stringify`. Groups hold their members through `parent`, as in React Flow,
 * Cytoscape and ELK.
 */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  /** Unique in the graph, and the same each time the same flow is drawn. */
  id: string;
  /**
   * `input` and `output` are the ends of the graph, `fn` is code, `agent` an agent, and
   * `choice` where the paths part (a branch, or the "done?" of a loop). The rest are groups.
   */
  kind: "input" | "output" | "fn" | "agent" | "choice" | "flow" | "parallel" | "forEach" | "until";
  /** What to show. */
  label: string;
  /** The `node` of the RunEvents this node emits, to lay a run's events over the graph. */
  name?: string;
  /** The group this node is in. */
  parent?: string;
  /** The state key the output is assigned to (assign). */
  assign?: string;
  /** Runs in a git worktree. */
  worktree?: true;
  /** The key of the output among those of a parallel node. */
  key?: string;
  /** How many items run at once (forEach); absent when all do. */
  concurrency?: number;
  /** Set when a failed node does not abort the others (parallel with failFast: false). */
  failFast?: false;
  /** How many times the body runs at most (until). */
  max?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** When the edge is taken: the case of a branch, or the "yes" or "no" of a loop. */
  when?: string;
  /** The output is mapped into the next input. */
  map?: true;
  /** The names of the middleware that wraps the node the edge leads to. */
  use?: string[];
}

/** Where edges to the next node leave from, and when they are taken there. */
interface Exit {
  id: string;
  when?: string;
}

/** What an edge carries into the node it leads to. */
interface Into {
  map?: true;
  use: string[];
}

/** Describes a node (usually a built flow) as a graph of plain data. */
export function toGraph(node: Node<never, unknown>): Graph {
  const nodes: GraphNode[] = [{ id: "in", kind: "input", label: "input" }];
  const edges: GraphEdge[] = [];
  let count = 0;
  const id = (prefix: string) => `${prefix}${count++}`;

  const connect = (from: Exit[], to: string, into: Into) => {
    for (const exit of from) {
      edges.push({
        from: exit.id,
        to,
        ...(exit.when !== undefined && { when: exit.when }),
        ...(into.map && { map: true }),
        ...(into.use.length > 0 && { use: into.use }),
      });
    }
  };

  /** Adds a node; extra says what wraps it (assign, worktree, the key in parallel). */
  const add = (node: Omit<GraphNode, "parent">, parent: string | undefined, extra: Partial<GraphNode>) => {
    nodes.push({ ...node, ...extra, ...(parent !== undefined && { parent }) });
    return node.id;
  };

  const draw = (
    node: Node<never, unknown>,
    from: Exit[],
    into: Into,
    parent: string | undefined,
    extra: Partial<GraphNode> = {},
  ): Exit[] => {
    const shape = node.shape ?? { kind: "fn" };
    const label = extra.label ?? node.name;
    const base = { name: node.name, label };
    switch (shape.kind) {
      case "fn":
      case "agent": {
        const n = add({ id: id("n"), kind: shape.kind, ...base }, parent, extra);
        connect(from, n, into);
        return [{ id: n }];
      }
      case "assign":
        return draw(shape.node, from, into, parent, { ...extra, assign: shape.key });
      case "worktree":
        return draw(shape.node, from, into, parent, { ...extra, worktree: true });
      case "branch": {
        const choice = add({ id: id("c"), kind: "choice", ...base }, parent, extra);
        connect(from, choice, into);
        return Object.entries(shape.cases).flatMap(([key, node]) =>
          draw(node, [{ id: choice, when: key }], { use: [] }, parent),
        );
      }
      case "forEach": {
        const group = add({ id: id("s"), kind: "forEach", ...base }, parent, {
          ...extra,
          ...(shape.concurrency !== undefined && { concurrency: shape.concurrency }),
        });
        return draw(shape.body, from, { ...into, use: [...into.use, ...shape.use] }, group);
      }
      case "flow": {
        const group = add({ id: id("s"), kind: "flow", ...base }, parent, extra);
        let exits = from;
        let edge = into;
        for (const step of shape.steps) {
          exits = draw(
            step.node,
            exits,
            { ...((edge.map || step.map) && { map: true }), use: [...edge.use, ...step.use] },
            group,
          );
          edge = { use: [] };
        }
        return exits;
      }
      case "parallel": {
        const group = add({ id: id("s"), kind: "parallel", ...base }, parent, {
          ...extra,
          ...(shape.failFast === false && { failFast: false }),
        });
        return Object.entries(shape.branches).flatMap(([key, branch]) =>
          draw(branch, from, { ...into, use: [...into.use, ...shape.use] }, group, { key }),
        );
      }
      case "until": {
        const group = add({ id: id("s"), kind: "until", ...base, max: shape.max }, parent, extra);
        const done = add({ id: id("c"), kind: "choice", label: "done?" }, group, {});
        connect(from, done, into);
        connect(draw(shape.body, [{ id: done, when: "no" }], { use: [] }, group), done, { use: [] });
        return [{ id: done, when: "yes" }];
      }
    }
  };

  const exits = draw(node, [{ id: "in" }], { use: [] }, undefined);
  nodes.push({ id: "out", kind: "output", label: "output" });
  connect(exits, "out", { use: [] });
  return { nodes, edges };
}

/** The JSON Schema (2020-12) of a Graph, for tools that check or generate types from it. */
export const graphSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Graph",
  description: "A flow as plain data: its nodes, the groups they are in, and the edges between them.",
  type: "object",
  required: ["nodes", "edges"],
  additionalProperties: false,
  properties: {
    nodes: { type: "array", items: { $ref: "#/$defs/node" } },
    edges: { type: "array", items: { $ref: "#/$defs/edge" } },
  },
  $defs: {
    node: {
      type: "object",
      required: ["id", "kind", "label"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Unique in the graph." },
        kind: {
          enum: ["input", "output", "fn", "agent", "choice", "flow", "parallel", "forEach", "until"],
          description:
            "input and output are the ends of the graph, fn is code, agent an agent, and choice where the paths part. The rest are groups.",
        },
        label: { type: "string", description: "What to show." },
        name: { type: "string", description: "The node of the run events this node emits." },
        parent: { type: "string", description: "The id of the group this node is in." },
        assign: { type: "string", description: "The state key the output is assigned to." },
        worktree: { const: true, description: "Runs in a git worktree." },
        key: { type: "string", description: "The key of the output among those of a parallel node." },
        concurrency: { type: "number", description: "How many items run at once (forEach); absent when all do." },
        failFast: {
          const: false,
          description: "Set when a failed node does not abort the others (parallel with failFast: false).",
        },
        max: { type: "number", description: "How many times the body runs at most (until)." },
      },
    },
    edge: {
      type: "object",
      required: ["from", "to"],
      additionalProperties: false,
      properties: {
        from: { type: "string", description: "The id of the node the edge leaves." },
        to: { type: "string", description: "The id of the node the edge leads to." },
        when: { type: "string", description: "When the edge is taken: the case of a branch, or yes or no of a loop." },
        map: { const: true, description: "The output is mapped into the next input." },
        use: {
          type: "array",
          items: { type: "string" },
          description: "The names of the middleware that wraps the node the edge leads to.",
        },
      },
    },
  },
} as const;
