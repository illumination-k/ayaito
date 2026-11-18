# ayaito

[日本語](README.ja.md)

A small engine for building agent workflows as typed graphs, whose agents run on Claude
([Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)), Codex, opencode or any agent that
speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP).

```bash
npm install ayaito zod @anthropic-ai/claude-agent-sdk # or @openai/codex-sdk, @opencode-ai/sdk, @agentclientprotocol/sdk
```

```ts
import { agentNode, assign, checkpoint, Flow, FsStore, run } from "ayaito";
import { claudeRuntime } from "ayaito/claude";

const selectTopic = agentNode(
  "select-topic",
  { prompt: (s: Input) => `Pick a topic for ${s.site}`, output: z.object({ topic: z.string() }), access: "read-only" },
  claudeRuntime({ maxBudgetUsd: 1 }),
);

const flow = Flow.start<Input>("weekly-article")
  .then(prepare) // fnNode: deterministic code
  .then(assign("topic", selectTopic), { use: [checkpoint] }) // agentNode: an agent
  .then(fixUntilGreen, { map: (s) => ({ ...s, fixes: 0 }) }) // map is required when the types differ
  .build(); // a Flow is a Node too

const result = await run(flow, input, { runId, store: new FsStore(".runs") });
if (result.status === "stopped") console.log(`${result.node}: ${result.reason}`);
```

| Part                           | Role                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Node<I, O>`                   | A named step: `fnNode` (code), `agentNode` (an agent's validated output), `refineNode` (an agent judged by a check)                                      |
| `AgentRuntime`                 | Where agents run: `claudeRuntime` (`ayaito/claude`), `codexRuntime` (`ayaito/codex`), `opencodeRuntime` (`ayaito/opencode`), `acpRuntime` (`ayaito/acp`) |
| `Edge` (the 2nd arg of `then`) | `map`, which turns the previous output into the next input, and middleware that wraps the node                                                           |
| middleware                     | `checkpoint` (stores the output by the hash of the input and skips it on rerun), `retry`, `effect` (side effects)                                        |
| `assign` / `until`             | Adds the output to the state for later nodes / repeats a node until it is done (check → fix)                                                             |
| `parallel`                     | Runs several nodes on the same input at once and returns their outputs under the same keys (e.g. checklist items)                                        |
| `run` / `FsStore`              | Runs a flow and saves the outputs and `events.jsonl` (start, end, cost, errors) under `<dir>/<runId>/`                                                   |
| `Stop`                         | Thrown by a node that finds nothing to do: the run ends early as a success (`status: "stopped"`)                                                         |
| `exec`                         | Runs a command and returns its exit code as the result, for gates such as tests                                                                          |

- Rerunning with the same run ID returns the saved output of nodes with `checkpoint`. A node whose input
  changed because an earlier node ran again runs again. To redo from a given node, use `store.invalidate`.
- `run` takes a `signal` to cancel the run; no node starts after it is aborted, and agents get it too. When a
  node of `parallel` fails, the others are aborted.
- Tokens and cost per model become `usage` events (codex reports tokens only, ACP the cost only). `usageReport(await ctx.history())`
  makes a per-node token table in markdown (it adds up runs before a resume and each pass of loops and retries).

### Agents

An agent node's request is portable: `prompt`, `output`, `system`, `model`, `cwd` and `access` (`"read-only"` or
`"write"`; calls run unattended, so nothing waits for approval). What only one runtime understands is set where the runtime is made: Claude's
`allowedTools`, `permissionMode`, `maxBudgetUsd` or in-process `mcpTools`, Codex's thread options, an opencode
server, the command of an ACP agent. A request's `access` replaces the tools and permissions the runtime was made with.

`output` is any schema that implements [Standard Schema](https://standardschema.dev/) with JSON Schema (zod
4.2+). It goes to the agent as JSON Schema, and the answer is validated against it.

- `agentNode` returns the validated output. An answer that misses the schema goes back to the same session,
  up to `attempts` calls (default 1); then the node throws.
- `refineNode` adds `check(result, input, attempt)`, a deterministic judge (a quote the source does not contain,
  a test that fails) that returns `{ ok: true, value }` or `{ ok: false, feedback }`. Feedback goes back to the
  same session, up to `maxAttempts` calls. The node's output is the `RefineResult`: running out of attempts is a
  result (`{ ok: false, feedback }`), not an error, so a later node can record what never passed. `refine`
  does the same outside a flow.
- Codex needs every object strict (`z.strictObject`). Do not use tuples (the Claude CLI validates with draft-07
  and the API with 2020-12, and one of them rejects them).
- `acpRuntime({ command, args })` starts an ACP agent as a child process and shares it between calls. `access`
  becomes the answer to the agent's permission requests (read-only allows reading and searching only), so an
  agent started in a mode that does not ask is not held back. ACP has no structured output: the schema goes
  into the prompt and the answer is parsed from the text. `model` sets the agent's model option, if it has one.
- `defineRuntime` makes a runtime from an adapter, for another agent or a test. A request carries the name of
  the node making it (`node`), for a runtime that shows or records its calls per node.

## Drawing a flow

`toMermaid(flow)` draws a node as a [Mermaid](https://mermaid.js.org/) flowchart, which GitHub renders in
markdown (a README, a pull request). Code is a box, an agent a rounded box, and flows, `parallel` and
`until` are subgraphs; each edge says whether it maps and which middleware wraps the next node.

````ts
console.log(["```mermaid", toMermaid(flow), "```"].join("\n"));
````

A middleware is labeled by its function name; name an anonymous one with `named("audit", m)`.

## Development

Uses [Vite+](https://viteplus.dev/).

```bash
vp install
vp check   # format, lint, type check
vp test
vp pack    # build dist/
```

Releases: bump `version` in `package.json` and push a `v<version>` tag. The workflow stages the
release on npm; publish it with `npm stage approve <id>`.

## License

MIT
