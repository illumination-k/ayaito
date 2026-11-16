# ayaito

[English](README.md)

[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) の上で、エージェントのワークフローを
型付きのグラフとして組む小さなエンジン。

```bash
npm install ayaito @anthropic-ai/claude-agent-sdk zod
```

```ts
const flow = Flow.start<Input>("weekly-article")
  .then(prepare) // fnNode: 決定的な処理
  .then(assign("topic", selectTopic), { use: [checkpoint] }) // agentNode: Claude Agent SDK
  .then(fixUntilGreen, { map: (s) => ({ ...s, fixes: 0 }) }) // 型が違えば map が必須
  .build(); // Flow も Node になる

await run(flow, input, { runId, store: new FsStore(".runs") });
```

| 部品                         | 役割                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Node<I, O>`                 | 名前付きの処理。`fnNode`（コード）と `agentNode`（Agent SDK。`tools` を渡すと ReAct のループ）        |
| `Edge`（`then` の第 2 引数） | 前の出力を次の入力に変える `map` と、ノードを包む middleware                                          |
| middleware                   | `checkpoint`（入力のハッシュで出力を保存し、再実行で飛ばす）・`retry`・`effect`（副作用・状態の登録） |
| `assign` / `until`           | 出力を状態に足して後ろのノードに渡す / 終わるまでノードを繰り返す（検査 → 修正）                      |
| `parallel`                   | 同じ入力で複数のノードを同時に走らせ、出力を同じキーで返す（チェックリストの各項目など）              |
| `run` / `FsStore`            | 実行と、`<dir>/<runId>/` への出力・`events.jsonl`（開始・終了・コスト・エラー）の保存                 |

- 同じ run ID で走らせ直すと、`checkpoint` の付いたノードは保存した出力を返す。前のノードが
  走り直して入力が変わったノードは走り直す。特定のノードからやり直すときは `store.invalidate`
- `agentNode` の出力は zod のスキーマで検証する（`outputFormat` の JSON Schema に変換して渡す）。
  モデル別のトークンと推定コストは `usage` イベントになる。`usageReport(await ctx.history())` でノード別の
  トークン表（markdown）を作れる（再開前の実行や、ループ・リトライの各回も合算する）
- JSON Schema は zod の refinement を表せないので、出力が `outputFormat` を満たしても検証で落ちることがある。
  `repairs: n` を渡すと、検証エラーを同じセッション（`resume`）に返して最大 n 回出し直させる（既定は 0）。
  `review` は検証を通った出力の問題（原文にない引用など）を返す関数で、同じ回数の中で差し戻し、使い切ったら
  出力をそのまま返す。スキーマにタプルは使わない（CLI は draft-07、API は 2020-12 で検証し、どちらかで落ちる）
- API エラー（スキーマの不正など）は subtype が success のまま `is_error` で返るので、例外にする

## フローの図

`toMermaid(flow)` はノードを [Mermaid](https://mermaid.js.org/) の flowchart にする（GitHub は README や PR の
markdown で描画する）。コードは四角、エージェントは角丸、フロー・`parallel`・`until` はサブグラフで、
エッジには `map` の有無と次のノードを包む middleware を書く。

````ts
console.log(["```mermaid", toMermaid(flow), "```"].join("\n"));
````

middleware は関数名で表示する。無名のものは `named("audit", m)` で名前を付ける。
