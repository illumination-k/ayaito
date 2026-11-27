# ayaito

[日本語](README.ja.md)

A small engine for building agent workflows as typed graphs, whose agents run on Claude
([Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)), Codex, opencode, Antigravity (`agy`) or any agent that
speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP).

```bash
npm install ayaito zod @anthropic-ai/claude-agent-sdk # or @openai/codex-sdk, @opencode-ai/sdk, @agentclientprotocol/sdk (also for agy)
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

| Part                           | Role                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Node<I, O>`                   | A named step: `fnNode` (code), `agentNode` (an agent's validated output), `refineNode` (an agent judged by a check)                                                                   |
| `AgentRuntime`                 | Where agents run: `claudeRuntime` (`ayaito/claude`), `codexRuntime` (`ayaito/codex`), `opencodeRuntime` (`ayaito/opencode`), `acpRuntime` (`ayaito/acp`), `agyRuntime` (`ayaito/agy`) |
| `Edge` (the 2nd arg of `then`) | `map`, which turns the previous output into the next input, and middleware that wraps the node                                                                                        |
| middleware                     | `checkpoint` (stores the output by the hash of the input and skips it on rerun), `retry`, `effect` (side effects), `timeout`, `budget`                                                |
| `assign` / `until`             | Adds the output to the state for later nodes / repeats a node until it is done (check → fix)                                                                                          |
| `parallel`                     | Runs several nodes on the same input at once and returns their outputs under the same keys (e.g. checklist items); with `failFast: false`, the others finish when one fails           |
| `forEach`                      | Runs a node on each item of a list, at most `concurrency` at once, and returns the outputs in order (e.g. the tasks a planner listed)                                                 |
| `branch`                       | Runs the one node that a function picks for the input (pass → ship, fail → fix; easy → a cheaper model)                                                                               |
| `worktree`                     | Runs a node in a git worktree on its own branch and can commit what it changed, so that agents that write can run side by side                                                        |
| `run` / `FsStore`              | Runs a flow and saves the outputs and `events.jsonl` (start, end, cost, errors, what agents do) under `<dir>/<runId>/`                                                                |
| `Stop`                         | Thrown by a node that finds nothing to do: the run ends early as a success (`status: "stopped"`)                                                                                      |
| `exec`                         | Runs a command and returns its exit code as the result, for gates such as tests                                                                                                       |

- Rerunning with the same run ID returns the saved output of nodes with `checkpoint`. A node whose input
  changed because an earlier node ran again runs again. To redo from a given node, use `store.invalidate`.
- `run` takes a `signal` to cancel the run; no node starts after it is aborted, and agents get it too. When a
  node of `parallel` fails, the others are aborted.
- `parallel(name, nodes, { failFast: false })` lets every node finish when one fails, and then throws an
  `AggregateError` whose `errors` are the failures, each with its `key`. With `use: [checkpoint]`, the nodes
  that succeeded keep their outputs, so a rerun with the same run ID runs only the failed ones: for nodes that
  are long, costly agent runs. Cancelling the run still aborts every node.
- `budget({ usd, tokens })` on an edge limits what a node spends, `run(..., { budget })` the whole run (counting
  earlier attempts of a resumed run): past it, the signal aborts and `BudgetError` is thrown. A call reports
  usage when it ends, so the call that goes over finishes. `timeout(ms)` aborts a node and throws `TimeoutError`;
  inside `retry` it limits each attempt, around it all of them. `retry` stops once the signal is aborted.
- `timeout(ms, { wrapUp: { ms, prompt } })` keeps the work done when time is up: an agent still working is
  interrupted and asked, in the same session, for its answer from what it has done so far (a `wrapUp` event).
  It has `wrapUp.ms` more for that, then the node times out as usual. An agent that starts after time is up
  is asked to answer at once, and `refineNode` makes no attempt after that answer. Runtimes report an
  interrupted call as `InterruptedError`, with its session and usage.
- What an agent says and the tools it calls become `activity` events as it works, so `events.jsonl` (or `run`'s
  `log`) shows what each agent is doing. Messages are cut to 1000 characters and tool inputs to 300.
- `run(..., { steer })` lets someone reach an agent at work: with `const steer = steering()`,
  `steer.send(node, message)` interrupts the turn of that node's agent and gives the message to the same session,
  which then goes on with its task (a `steer` event). It is no new attempt. `send` returns `false` when no agent
  of the node is working. Only agent nodes can be reached; the tool call in progress is cut off.
  In a `forEach`, `fix#2` reaches the agent of item 2 (the index in the list; `fix` alone reaches all of them),
  and events inside it carry `item`. An agent can be reached by its session's id too: a `session` event has it as
  soon as the call starts, which also lets you resume the session yourself.
  `steer.stop(node)` ends an agent's work without failing the node: it is interrupted and asked for its answer
  from what it has done so far (a `wrapUp` event with `stopped`), and `refineNode` makes no attempt after it.
- `branch`'s cases must cover every key the function can return, checked by the type. Annotate the function's
  input, as with `fnNode`.
- `worktree(node, { commit })` gives the node the worktree as `ctx.cwd`, which agent nodes without a `cwd` use
  (`run(..., { cwd })` sets it for the whole run). Its output is `{ output, branch, path, commit }`. The branch
  defaults to `ayaito/<runId>/<node>-<hash of the input>`, so a resumed run finds it again; `remove: true`
  removes the worktree and keeps the branch.
- Tokens and cost per model become `usage` events (codex reports tokens only). `usageReport(await ctx.history())`
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
- `claudeRuntime` runs `read-only` calls in `dontAsk` mode. `write` calls answer permission requests with
  `canUseTool`: Edit and Write are allowed only for files whose real path is inside `cwd` (so a worktree under a
  `.claude` directory, which `dontAsk` refuses to edit, works), and nothing is ever prompted. A `canUseTool` passed
  in the options replaces this rule.
- `acpRuntime({ command, args })` starts an ACP agent as a child process and shares it between calls. `access`
  becomes the answer to the agent's permission requests (read-only allows reading and searching only), so an
  agent started in a mode that does not ask is not held back. ACP has no structured output: the schema goes
  into the prompt and the answer is parsed from the text. `model` sets the agent's model option, if it has one.
  `meta` goes to the agent as the `_meta` of its sessions, for settings only that agent understands.
- `agyRuntime({ addDirs, agent, sandbox })` runs the Antigravity CLI through its ACP server (`agy acp`), as
  `acpRuntime` does. Sign in first with `agy` or `agy acp --login`, or pass `GEMINI_API_KEY` in `env`.
  `--dangerously-skip-permissions` would let agents do what `access` refuses, so it is not an option.
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

### As data

`toGraph(flow)` returns the same graph as plain JSON, for tools other than Mermaid (React Flow, Cytoscape,
ELK, Graphviz, a panel of your own). `toMermaid` takes a graph too.

```ts
const { nodes, edges } = toGraph(flow);
// nodes: { id, kind, label, name?, parent?, assign?, worktree?, key?, concurrency?, max? }
// edges: { from, to, when?, map?, use? }
```

`kind` is `input`, `output`, `fn`, `agent`, `choice`, or a group (`flow`, `parallel`, `forEach`, `until`) that
holds its members through their `parent`. `name` is the `node` of the run's events, so `events.jsonl` can be
laid over the graph to show what is running, done or failed.

`graphSchema` is the [JSON Schema](https://json-schema.org/) of that graph, to check one or to generate types
in another language: `JSON.stringify(graphSchema)`.

### From the command line

`ayaito run flow.ts` runs the flow a file exports as default and saves the run under `.runs/<run id>/`, with the
result as `result.json`; `ayaito graph flow.ts` prints its graph as JSON (`--mermaid` for a flowchart). Node
runs a `.ts` file by stripping its types (22.18 or later).

```bash
npx ayaito run flow.ts --run-id weekly --input '{"site":"blog"}'   # the same run id resumes the run
npx ayaito graph flow.ts > graph.json
npx ayaito steer weekly select-topic "Pick something seasonal."   # to the agent of a node that is running
npx ayaito stop weekly select-topic   # that agent answers now and the run goes on; without a node, stops the run
```

### In Claude Code

`run` saves the graph as `graph.json` beside `events.jsonl`. The mod in [`mods/ayaito`](mods/ayaito) reads both
and shows the run on its graph in a pane beside the chat, live: `claude --plugin-dir mods/ayaito`, then `/ayaito`.
It also gives Claude a tool to write a flow and start it in the background, as it would a workflow of
subagents: the pane follows the run and its result comes back to the conversation.

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
