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
