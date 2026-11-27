# ayaito

[English](README.md)

エージェントのワークフローを型付きのグラフとして組む小さなエンジン。エージェントは Claude
（[Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)）・Codex・opencode・Antigravity（`agy`）のほか、
[Agent Client Protocol](https://agentclientprotocol.com)（ACP）を話すエージェントで動かせる。

```bash
npm install ayaito zod @anthropic-ai/claude-agent-sdk # か @openai/codex-sdk・@opencode-ai/sdk・@agentclientprotocol/sdk（agy もこれ）
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

| 部品                         | 役割                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Node<I, O>`                 | 名前付きの処理。`fnNode`（コード）・`agentNode`（エージェントの検証済みの出力）・`refineNode`（検査で判定するエージェント）                                                                      |
| `AgentRuntime`               | エージェントの実行環境。`claudeRuntime`（`ayaito/claude`）・`codexRuntime`（`ayaito/codex`）・`opencodeRuntime`（`ayaito/opencode`）・`acpRuntime`（`ayaito/acp`）・`agyRuntime`（`ayaito/agy`） |
| `Edge`（`then` の第 2 引数） | 前の出力を次の入力に変える `map` と、ノードを包む middleware                                                                                                                                     |
| middleware                   | `checkpoint`（入力のハッシュで出力を保存し、再実行で飛ばす）・`retry`・`effect`（副作用・状態の登録）・`timeout`・`budget`                                                                       |
| `assign` / `until`           | 出力を状態に足して後ろのノードに渡す / 終わるまでノードを繰り返す（検査 → 修正）                                                                                                                 |
| `parallel`                   | 同じ入力で複数のノードを同時に走らせ、出力を同じキーで返す（チェックリストの各項目など）                                                                                                         |
| `forEach`                    | リストの各項目にノードを走らせ（同時に `concurrency` 個まで）、出力を項目の順で返す（計画役が挙げたタスクなど）                                                                                  |
| `branch`                     | 関数が入力ごとに選んだノードを 1 つ走らせる（通れば出荷・落ちれば修正、易しければ安いモデル）                                                                                                    |
| `worktree`                   | ノードを専用ブランチの git worktree で走らせ、変更をコミットできる。書き込むエージェントを並べて走らせるため                                                                                     |
| `run` / `FsStore`            | 実行と、`<dir>/<runId>/` への出力・`events.jsonl`（開始・終了・コスト・エラー・エージェントの動き）の保存                                                                                        |
| `Stop`                       | やることのないノードが投げる。実行を成功のまま打ち切る（`status: "stopped"`）                                                                                                                    |
| `exec`                       | コマンドを走らせ、終了コードを結果として返す（テストなどの検査に使う）                                                                                                                           |

- 同じ run ID で走らせ直すと、`checkpoint` の付いたノードは保存した出力を返す。前のノードが
  走り直して入力が変わったノードは走り直す。特定のノードからやり直すときは `store.invalidate`
- `run` に `signal` を渡すと実行を止められる。止めた後はノードを始めず、エージェントにも伝わる。
  `parallel` の 1 つが失敗すると、ほかも止める
- edge の `budget({ usd, tokens })` はノードの、`run(..., { budget })` は実行全体の支出を制限する（再開した実行は
  それまでの分も数える）。超えると signal を止めて `BudgetError` を投げる。呼び出しは終わるときに使用量を報告するので、
  超えた呼び出しは最後まで走る。`timeout(ms)` はノードを止めて `TimeoutError` を投げる。`retry` の内側なら各回、
  外側なら全体を制限する。`retry` は signal が止まったらやり直さない
- `timeout(ms, { wrapUp: { ms, prompt } })` は時間切れでもそれまでの作業を活かす。作業中のエージェントを中断し、
  同じセッションでそれまでの結果から答えるよう頼む（`wrapUp` イベント）。その猶予が `wrapUp.ms` で、過ぎれば通常どおり
  タイムアウトする。時間切れの後に始まるエージェントにはすぐ答えるよう頼み、`refineNode` はその答えの後に試行しない。
  中断した呼び出しは実行環境が `InterruptedError`（セッションと使用量つき）として返す
- エージェントの発言とツール呼び出しは、作業中に `activity` イベントになる。`events.jsonl`（または `run` の `log`）で
  各エージェントが何をしているか分かる。発言は 1000 文字、ツールの入力は 300 文字で切る
- `run(..., { steer })` で作業中のエージェントに介入できる。`const steer = steering()` として
  `steer.send(node, message)` を呼ぶと、そのノードのエージェントのターンを中断し、同じセッションにメッセージを渡す。
  エージェントはそれを踏まえて作業を続ける（`steer` イベント）。試行回数には数えない。そのノードのエージェントが
  作業中でなければ `send` は `false` を返す。介入できるのはエージェントのノードだけで、実行中のツール呼び出しは打ち切られる。
  `forEach` の中では `fix#2` で 2 番目（リストの添字）の項目のエージェントに届き（`fix` だけなら全員）、中のイベントには
  `item` が付く。セッション ID でも届く。呼び出しが始まるとすぐ `session` イベントに記録されるので、自分でそのセッションを
  再開することもできる。
  `steer.stop(node)` はノードを失敗させずにエージェントの作業を終わらせる。中断して、それまでの結果から答えるよう頼み
  （`stopped` つきの `wrapUp` イベント）、`refineNode` はその後に試行しない
- `branch` の cases は関数が返しうるキーをすべて持つ必要があり、型で検査する。関数の入力には `fnNode` と同じく型を書く
- `worktree(node, { commit })` はノードに worktree を `ctx.cwd` として渡し、`cwd` のないエージェントのノードはそこで動く
  （`run(..., { cwd })` で実行全体に設定できる）。出力は `{ output, branch, path, commit }`。ブランチは既定で
  `ayaito/<runId>/<ノード>-<入力のハッシュ>` なので、再開した実行は同じものを使う。`remove: true` は worktree を消し、
  ブランチは残す
- モデル別のトークンと費用は `usage` イベントになる（codex はトークンだけ）。`usageReport(await ctx.history())` で
  ノード別のトークン表（markdown）を作れる（再開前の実行や、ループ・リトライの各回も合算する）

### エージェント

エージェントのノードの指定は実行環境をまたいで同じ意味になる: `prompt`・`output`・`system`・`model`・`cwd`・
`access`（`"read-only"` か `"write"`。無人で動くので承認は待たない）。一つの実行環境にしかない設定は、実行環境を作るときに渡す
（Claude の `allowedTools`・`permissionMode`・`maxBudgetUsd`・プロセス内の `mcpTools`、Codex のスレッドの設定、
opencode のサーバー、ACP のエージェントのコマンド）。`access` を指定すると、実行環境に渡したツールと権限を置き換える。

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
- `acpRuntime({ command, args })` は ACP のエージェントを子プロセスとして起動し、呼び出しの間で共有する。`access` は
  エージェントの許可の求めへの答えになる（read-only は読み取りと検索だけ許す）ので、許可を求めないモードで起動した
  エージェントは止められない。ACP に構造化出力はないので、スキーマはプロンプトに入れ、答えの文章から JSON を取り出す。
  `model` は、エージェントにモデルの設定があればそれを切り替える。`meta` はセッションの `_meta` としてエージェントに渡す
  （そのエージェントにしかない設定用）
- `agyRuntime({ addDirs, agent, sandbox })` は Antigravity の CLI を ACP サーバー（`agy acp`）で動かす。動きは
  `acpRuntime` と同じ。先に `agy` か `agy acp --login` でサインインするか、`env` に `GEMINI_API_KEY` を渡す。
  `--dangerously-skip-permissions` は `access` が拒むことまでエージェントにさせてしまうので、オプションにしていない
- `defineRuntime` はアダプタから実行環境を作る（ほかのエージェントやテスト用）。呼び出しには呼んだノードの名前
  （`node`）が入るので、ノードごとに呼び出しを見せたり記録したりする実行環境で使える

## フローの図

`toMermaid(flow)` はノードを [Mermaid](https://mermaid.js.org/) の flowchart にする（GitHub は README や PR の
markdown で描画する）。コードは四角、エージェントは角丸、フロー・`parallel`・`until` はサブグラフで、
エッジには `map` の有無と次のノードを包む middleware を書く。

````ts
console.log(["```mermaid", toMermaid(flow), "```"].join("\n"));
````

middleware は関数名で表示する。無名のものは `named("audit", m)` で名前を付ける。

### データとして

`toGraph(flow)` は同じグラフをプレーンな JSON で返す。Mermaid 以外のツール（React Flow、Cytoscape、ELK、
Graphviz、自作のパネル）に渡せる。`toMermaid` はグラフも受け取る。

```ts
const { nodes, edges } = toGraph(flow);
// nodes: { id, kind, label, name?, parent?, assign?, worktree?, key?, concurrency?, max? }
// edges: { from, to, when?, map?, use? }
```

`kind` は `input`、`output`、`fn`、`agent`、`choice`、またはグループ（`flow`、`parallel`、`forEach`、`until`）で、
グループの中身は `parent` で示す。`name` は実行イベントの `node` と同じなので、`events.jsonl` をグラフに重ねて
実行中・完了・失敗を表示できる。

`graphSchema` はこのグラフの [JSON Schema](https://json-schema.org/) で、検証や他言語での型生成に使える
（`JSON.stringify(graphSchema)`）。

### コマンドラインから

`ayaito run flow.ts` はファイルが default export するフローを実行し、`.runs/<run id>/` に保存する（結果は
`result.json`）。`ayaito graph flow.ts` はグラフを JSON で出力する（`--mermaid` で flowchart）。`.ts` は Node が
型を取り除いて実行する（22.18 以降）。

```bash
npx ayaito run flow.ts --run-id weekly --input '{"site":"blog"}'   # 同じ run id なら再開する
npx ayaito graph flow.ts > graph.json
npx ayaito steer weekly select-topic "季節の話題にして"   # 実行中のノードのエージェントへ
npx ayaito stop weekly select-topic   # そのエージェントはすぐ答え、実行は続く。ノードなしなら実行を止める
```

### Claude Code で見る

`run` はグラフを `graph.json` として `events.jsonl` の隣に保存する。[`mods/ayaito`](mods/ayaito) の mod は両方を読み、
チャットの横のペインに実行状況をグラフ上で表示する（実行中も追従する）。`claude --plugin-dir mods/ayaito` で起動し、
`/ayaito` で開く。
mod は Claude にフローを書いてバックグラウンドで起動するツールも渡す（サブエージェントのワークフローと同じ感覚で
使える）。ペインが実行を追い、結果は会話に戻る。
