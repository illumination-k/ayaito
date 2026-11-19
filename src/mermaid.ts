import type { Node } from "./node.ts";

/** Where edges to the next node leave from, and what they say there (the "yes" of a loop). */
interface Exit {
  id: string;
  label?: string;
}

/**
 * Draws a node (usually a built flow) as a Mermaid flowchart: code as boxes, agents as
 * rounded boxes, choices of branch as diamonds, and flows, parallel and forEach nodes and loops
 * as subgraphs. An edge says whether it maps
 * and which middleware wraps the node it leads to.
 */
export function toMermaid(node: Node<never, unknown>): string {
  const nodes = ["flowchart TD", "  in((input))"];
  const edges: string[] = [];
  let count = 0;
  const id = (prefix: string) => `${prefix}${count++}`;

  const connect = (from: Exit[], to: string, label: string[]) => {
    for (const exit of from) {
      const text = [exit.label, ...label].filter(Boolean).join(", ");
      edges.push(text ? `  ${exit.id} -->|"${escape(text)}"| ${to}` : `  ${exit.id} --> ${to}`);
    }
  };

  const draw = (
    node: Node<never, unknown>,
    from: Exit[],
    label: string[],
    depth: number,
    title = node.name,
  ): Exit[] => {
    const shape = node.shape ?? { kind: "fn" };
    const pad = "  ".repeat(depth);
    switch (shape.kind) {
      case "fn":
      case "agent": {
        const n = id("n");
        nodes.push(
          shape.kind === "agent" ? `${pad}${n}(["${escape(title)}"]):::agent` : `${pad}${n}["${escape(title)}"]`,
        );
        connect(from, n, label);
        return [{ id: n }];
      }
      case "assign":
        return draw(shape.node, from, label, depth, `${shape.node.name} → ${shape.key}`);
      case "worktree":
        return draw(shape.node, from, label, depth, `${title} (worktree)`);
      case "branch": {
        const choice = id("c");
        nodes.push(`${pad}${choice}{"${escape(title)}"}`);
        connect(from, choice, label);
        return Object.entries(shape.cases).flatMap(([key, node]) =>
          draw(node, [{ id: choice, label: key }], [], depth),
        );
      }
      case "forEach": {
        const limit = shape.concurrency === undefined ? "" : `, ${shape.concurrency} at a time`;
        nodes.push(`${pad}subgraph ${id("s")}["${escape(`${title} (each item${limit})`)}"]`);
        const exits = draw(shape.body, from, [...label, ...shape.use], depth + 1);
        nodes.push(`${pad}end`);
        return exits;
      }
      case "flow": {
        nodes.push(`${pad}subgraph ${id("s")}["${escape(title)}"]`);
        let exits = from;
        let edge = label;
        for (const step of shape.steps) {
          exits = draw(step.node, exits, [...edge, ...(step.map ? ["map"] : []), ...step.use], depth + 1);
          edge = [];
        }
        nodes.push(`${pad}end`);
        return exits;
      }
      case "parallel": {
        nodes.push(`${pad}subgraph ${id("s")}["${escape(title)}"]`);
        const exits = Object.entries(shape.branches).flatMap(([key, branch]) =>
          draw(branch, from, [...label, ...shape.use], depth + 1, key === branch.name ? key : `${key}: ${branch.name}`),
        );
        nodes.push(`${pad}end`);
        return exits;
      }
      case "until": {
        nodes.push(`${pad}subgraph ${id("s")}["${escape(`${title} (at most ${shape.max})`)}"]`);
        const done = id("c");
        nodes.push(`${pad}  ${done}{"done?"}`);
        connect(from, done, label);
        connect(draw(shape.body, [{ id: done, label: "no" }], [], depth + 1), done, []);
        nodes.push(`${pad}end`);
        return [{ id: done, label: "yes" }];
      }
    }
  };

  const exits = draw(node, [{ id: "in" }], [], 1);
  nodes.push("  out((output))");
  connect(exits, "out", []);
  return [...nodes, ...edges, "  classDef agent fill:#ede9fe,stroke:#7c3aed"].join("\n");
}

/** Mermaid ends a quoted label at `"`; the entity keeps it. */
function escape(text: string): string {
  return text.replaceAll('"', "#quot;");
}
