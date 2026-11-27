import { type Graph, type GraphNode, toGraph } from "./graph.ts";
import type { Node } from "./node.ts";

/**
 * Draws a node (usually a built flow), or its graph from toGraph, as a Mermaid flowchart:
 * code as boxes, agents as rounded boxes, choices of branch as diamonds, and flows, parallel
 * and forEach nodes and loops as subgraphs. An edge says whether it maps and which
 * middleware wraps the node it leads to.
 */
export function toMermaid(node: Node<never, unknown> | Graph): string {
  const graph = "nodes" in node ? node : toGraph(node);
  const lines = ["flowchart TD"];

  const draw = (parent: string | undefined, depth: number) => {
    const pad = "  ".repeat(depth);
    for (const n of graph.nodes) {
      if (n.parent !== parent) continue;
      const text = `"${escape(title(n))}"`;
      switch (n.kind) {
        case "input":
        case "output":
          lines.push(`${pad}${n.id}((${n.label}))`);
          break;
        case "fn":
          lines.push(`${pad}${n.id}[${text}]`);
          break;
        case "agent":
          lines.push(`${pad}${n.id}([${text}]):::agent`);
          break;
        case "choice":
          lines.push(`${pad}${n.id}{${text}}`);
          break;
        default:
          lines.push(`${pad}subgraph ${n.id}[${text}]`);
          draw(n.id, depth + 1);
          lines.push(`${pad}end`);
      }
    }
  };
  draw(undefined, 1);

  for (const edge of graph.edges) {
    const text = [edge.when, edge.map && "map", ...(edge.use ?? [])].filter(Boolean).join(", ");
    lines.push(text ? `  ${edge.from} -->|"${escape(text)}"| ${edge.to}` : `  ${edge.from} --> ${edge.to}`);
  }
  return [...lines, "  classDef agent fill:#ede9fe,stroke:#7c3aed"].join("\n");
}

/** The label with what wraps the node: its key in parallel, assign, a worktree, the limits of a group. */
function title(n: GraphNode): string {
  let text = n.key === undefined || n.key === n.label ? n.label : `${n.key}: ${n.label}`;
  if (n.assign !== undefined) text += ` → ${n.assign}`;
  if (n.worktree) text += " (worktree)";
  const all = n.failFast === false ? ", all finish" : "";
  if (n.kind === "forEach")
    text += ` (each item${n.concurrency === undefined ? "" : `, ${n.concurrency} at a time`}${all})`;
  else if (n.failFast === false) text += " (all finish)";
  if (n.kind === "until") text += ` (at most ${n.max})`;
  return text;
}

/** Mermaid ends a quoted label at `"`; the entity keeps it. */
function escape(text: string): string {
  return text.replaceAll('"', "#quot;");
}
