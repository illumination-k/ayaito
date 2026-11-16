# ayaito

[日本語](README.ja.md)

A small engine for building agent workflows as typed graphs on the
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

```bash
npm install ayaito @anthropic-ai/claude-agent-sdk zod
```

```ts
import { assign, checkpoint, Flow, FsStore, run } from "ayaito";

const flow = Flow.start<Input>("weekly-article")
  .then(prepare) // fnNode: deterministic code
  .then(assign("topic", selectTopic), { use: [checkpoint] }) // agentNode: Claude Agent SDK
  .then(fixUntilGreen, { map: (s) => ({ ...s, fixes: 0 }) }) // map is required when the types differ
  .build(); // a Flow is a Node too

await run(flow, input, { runId, store: new FsStore(".runs") });
```

| Part                           | Role                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `Node<I, O>`                   | A named step. `fnNode` (code) and `agentNode` (Agent SDK; pass `tools` for a ReAct loop)                          |
| `Edge` (the 2nd arg of `then`) | `map`, which turns the previous output into the next input, and middleware that wraps the node                    |
| middleware                     | `checkpoint` (stores the output by the hash of the input and skips it on rerun), `retry`, `effect` (side effects) |
| `assign` / `until`             | Adds the output to the state for later nodes / repeats a node until it is done (check → fix)                      |
| `parallel`                     | Runs several nodes on the same input at once and returns their outputs under the same keys (e.g. checklist items) |
| `run` / `FsStore`              | Runs a flow and saves the outputs and `events.jsonl` (start, end, cost, errors) under `<dir>/<runId>/`            |

- Rerunning with the same run ID returns the saved output of nodes with `checkpoint`. A node whose input
  changed because an earlier node ran again runs again. To redo from a given node, use `store.invalidate`.
- The output of `agentNode` is validated with a zod schema (converted to JSON Schema and passed as
  `outputFormat`). Tokens and estimated cost per model become `usage` events.
  `usageReport(await ctx.history())` makes a per-node token table in markdown (it adds up runs before a
  resume and each pass of loops and retries).
- JSON Schema cannot express zod refinements, so an output can satisfy `outputFormat` and still fail
  validation. With `repairs: n`, the validation errors go back to the same session (`resume`) up to n times
  (default 0). `review` is a function that returns problems in a validated output (such as a quote that is not
  in the source); it sends them back within the same budget and returns the output as is when the budget runs
  out. Do not use tuples in schemas (the CLI validates with draft-07 and the API with 2020-12, and one of them
  fails).
- API errors (such as an invalid schema) come back as `is_error` with a `success` subtype; they are thrown.

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
