# ayaito

[English](README.md)

エージェントのワークフローを型付きのグラフとして組む小さなエンジン。エージェントは Claude
（[Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)）・Codex・opencode のどれでも動かせる。

```bash
npm install ayaito zod @anthropic-ai/claude-agent-sdk # か @openai/codex-sdk・@opencode-ai/sdk
```

```ts
import { agentNode, assign, checkpoint, Flow, FsStore, run } from "ayaito";
import { claudeRuntime } from "ayaito/claude";

const selectTopic = agentNode(
  "select-topic",
  { prompt: (s: Input) => `${s.site} の記事の題を選ぶ`, output: z.object({ topic: z.string() }), access: "read-only" },
  claudeRuntime({ maxBudgetUsd: 1 }),
);

const flow = Flow.start<Input>("weekly-article")
  .then(prepare) // fnNode: 決定的な処理
  .then(assign("topic", selectTopic), { use: [checkpoint] }) // agentNode: エージェント
  .then(fixUntilGreen, { map: (s) => ({ ...s, fixes: 0 }) }) // 型が違えば map が必須
  .build(); // Flow も Node になる

const result = await run(flow, input, { runId, store: new FsStore(".runs") });
if (result.status === "stopped") console.log(`${result.node}: ${result.reason}`);
```

| 部品                         | 役割                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Node<I, O>`                 | 名前付きの処理。`fnNode`（コード）・`agentNode`（エージェントの検証済みの出力）・`refineNode`（検査で判定するエージェント）          |
| `AgentRuntime`               | エージェントの実行環境。`claudeRuntime`（`ayaito/claude`）・`codexRuntime`（`ayaito/codex`）・`opencodeRuntime`（`ayaito/opencode`） |
| `Edge`（`then` の第 2 引数） | 前の出力を次の入力に変える `map` と、ノードを包む middleware                                                                         |
| middleware                   | `checkpoint`（入力のハッシュで出力を保存し、再実行で飛ばす）・`retry`・`effect`（副作用・状態の登録）                                |
| `assign` / `until`           | 出力を状態に足して後ろのノードに渡す / 終わるまでノードを繰り返す（検査 → 修正）                                                     |
| `parallel`                   | 同じ入力で複数のノードを同時に走らせ、出力を同じキーで返す（チェックリストの各項目など）                                             |
| `run` / `FsStore`            | 実行と、`<dir>/<runId>/` への出力・`events.jsonl`（開始・終了・コスト・エラー）の保存                                                |
| `Stop`                       | やることのないノードが投げる。実行を成功のまま打ち切る（`status: "stopped"`）                                                        |
| `exec`                       | コマンドを走らせ、終了コードを結果として返す（テストなどの検査に使う）                                                               |

- 同じ run ID で走らせ直すと、`checkpoint` の付いたノードは保存した出力を返す。前のノードが
  走り直して入力が変わったノードは走り直す。特定のノードからやり直すときは `store.invalidate`
- `run` に `signal` を渡すと実行を止められる。止めた後はノードを始めず、エージェントにも伝わる。
  `parallel` の 1 つが失敗すると、ほかも止める
- モデル別のトークンと費用は `usage` イベントになる（codex はトークンだけ）。`usageReport(await ctx.history())` で
  ノード別のトークン表（markdown）を作れる（再開前の実行や、ループ・リトライの各回も合算する）

### エージェント

エージェントのノードの指定は実行環境をまたいで同じ意味になる: `prompt`・`output`・`system`・`model`・`cwd`・
`access`（`"read-only"` か `"write"`。無人で動くので承認は待たない）。一つの実行環境にしかない設定は、実行環境を作るときに渡す
（Claude の `allowedTools`・`permissionMode`・`maxBudgetUsd`・プロセス内の `mcpTools`、Codex のスレッドの設定、
opencode のサーバー）。`access` を指定すると、実行環境に渡したツールと権限を置き換える。

`output` は JSON Schema を出せる [Standard Schema](https://standardschema.dev/) のスキーマ（zod 4.2+）。
JSON Schema にしてエージェントに渡し、答えをそれで検証する。

- `agentNode` は検証済みの出力を返す。スキーマに合わない答えは同じセッションに返し、`attempts` 回
  （既定 1）まで呼ぶ。それでも合わなければ例外にする
- `refineNode` は `check(result, input, attempt)` を足す。決まった手順の判定（原文にない引用、落ちるテストなど）で、
  `{ ok: true, value }` か `{ ok: false, feedback }` を返す。feedback は同じセッションに返し、`maxAttempts` 回まで呼ぶ。
  ノードの出力は `RefineResult` で、使い切っても例外にせず結果（`{ ok: false, feedback }`）として返すので、
  後ろのノードで通らなかったものを記録できる。フローの外では `refine` で同じことをする
- Codex ではオブジェクトをすべて strict にする（`z.strictObject`）。タプルは使わない（Claude の CLI は draft-07、
  API は 2020-12 で検証し、どちらかで落ちる）
- `defineRuntime` はアダプタから実行環境を作る（ほかのエージェントやテスト用）

## フローの図

`toMermaid(flow)` はノードを [Mermaid](https://mermaid.js.org/) の flowchart にする（GitHub は README や PR の
markdown で描画する）。コードは四角、エージェントは角丸、フロー・`parallel`・`until` はサブグラフで、
エッジには `map` の有無と次のノードを包む middleware を書く。

````ts
console.log(["```mermaid", toMermaid(flow), "```"].join("\n"));
````

middleware は関数名で表示する。無名のものは `named("audit", m)` で名前を付ける。
