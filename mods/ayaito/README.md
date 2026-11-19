# ayaito mod for Claude Code

A pane beside the chat that shows an [ayaito](../../README.md) run on its flow's graph: which nodes are
running, done, failed or skipped, how long each took and what it cost. It reads the files `run` saves with
`FsStore` under `<dir>/<runId>/`: `graph.json` (the flow as `toGraph` describes it) and `events.jsonl`.

```bash
claude --plugin-dir mods/ayaito
```

Then `/ayaito` opens the pane on the run that last wrote an event in `.runs`. `/ayaito <dir>` reads runs from
another folder, and `/ayaito <dir> <runId>` stays on one run. The pane follows the run while it goes on.

| Mark | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `○`  | not started                                                 |
| `●`  | running                                                     |
| `✓`  | done                                                        |
| `✗`  | failed, with the error under it                             |
| `↷`  | skipped: a checkpoint had its output, or a branch not taken |
| `■`  | the run stopped here (`Stop`)                               |

Nodes are matched to events by name, so two nodes with the same name show the same state. A run made with an
ayaito that saves no `graph.json` (0.2.0 and earlier) cannot be shown.

Tests: `claude plugin test mods/ayaito`.

## Flows that Claude writes

The mod gives Claude two tools. With `mcp__ayaito__run`, Claude writes a flow as a TypeScript module and starts
it in the background, as it would a workflow of subagents: the call returns at once, the pane shows the run on
its graph, and when the run ends its result reaches Claude as a message, which starts a turn. Ask for it in
words: "run an ayaito flow that plans the fixes, fixes each in its own worktree and runs the tests".

- The flow, its input, log and result are saved under `<dir>/<runId>/` (`flow.ts`, `input.json`, `run.log`,
  `result.json`), beside the run's events and checkpoints. Passing a `runId` again resumes that run from its
  checkpoints, with the saved flow or a new one.
- `mcp__ayaito__stop` stops a run. A run is a process of its own (`ayaito run`, started with `nohup`), so it
  goes on when the mod reloads or the session ends; one that outlives the session is not reported to a later
  one.
- The project needs `ayaito` installed (`node_modules/.bin/ayaito`), `zod`, and the SDK of the runtime the
  flow's agents use. The flow is run by Node, which strips its types (Node 22.18 or later) and does not check
  them. Starting a run needs `sh`, so not Windows.
- The flow is code that Claude wrote, run with your permissions: the tool call asks first, as any tool does.
