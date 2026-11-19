import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Status, View } from "../types";
import { RUN, RUN_SPEC, start, STEER, STEER_SPEC, steer, STOP, STOP_SPEC, stop, watch } from "./runs";
import { money, parseEvents, view as toView } from "./view";
import type { Graph } from "./view";

const PANE = "ayaito";
const TITLE = "ayaito run";
const DIR = ".runs";
/** A read answers at most 4 MiB: of a longer events.jsonl, the end is read. */
const TAIL = 3 * 1024 * 1024;

// Change a tag when the value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const source = atom({ plugin: "ayaito", key: "source" } as const, { dir: DIR }, { shape: "source-1" });
const shown = atom(
  { plugin: "ayaito", key: "view" } as const,
  { dir: DIR, rows: [], done: 0, total: 0, usd: 0 },
  {
    shape: "view-2",
  },
);

const MARK: Record<Status, string> = { pending: "○", running: "●", done: "✓", failed: "✗", skipped: "↷", stopped: "■" };
const COLOR: Record<Status, string | undefined> = {
  pending: undefined,
  running: "warning",
  done: "success",
  failed: "error",
  skipped: undefined,
  stopped: "warning",
};

/** What was last read, so that a run that wrote nothing new is not read again. */
let seen = "";

/** The run that last wrote an event, of those in dir. */
async function latest($: EngineInterface, dir: string): Promise<string | undefined> {
  const entries = await $.fs.list(dir);
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.kind === "dir")
      .map(async (entry) => {
        const stat = await $.fs.stat(`${dir}/${entry.name}/events.jsonl`).catch(() => undefined);
        return { name: entry.name, at: stat?.mtimeMs ?? -1 };
      }),
  );
  return runs.filter((run) => run.at >= 0).sort((a, b) => b.at - a.at)[0]?.name;
}

async function refresh($: EngineInterface): Promise<void> {
  const { dir, runId: pinned } = await read($, source);
  const empty = (note: string): View => ({ dir, rows: [], done: 0, total: 0, usd: 0, note });
  const show = async (key: string, make: () => View | Promise<View>) => {
    if (key === seen) return;
    const next = await make();
    await update($, shown, () => next);
    seen = key;
  };

  const runId = pinned ?? (await latest($, dir).catch(() => undefined));
  if (runId === undefined) return show(`none:${dir}`, () => empty(`No runs in ${dir} yet.`));
  const base = `${dir}/${runId}`;
  const [events, graph] = await Promise.all([
    $.fs.stat(`${base}/events.jsonl`).catch(() => undefined),
    $.fs.stat(`${base}/graph.json`).catch(() => undefined),
  ]);
  if (graph === undefined) {
    const why =
      events === undefined
        ? `No run ${runId} in ${dir}.`
        : `Run ${runId} has no graph.json: it ran on an ayaito that does not save one.`;
    return show(`nograph:${base}:${events !== undefined}`, () => empty(why));
  }
  const size = events?.size ?? 0;
  return show(`${base}:${size}:${graph.mtimeMs}`, async () => {
    const offset = Math.max(0, size - TAIL);
    const [graphText, eventsText] = await Promise.all([
      $.fs.read(`${base}/graph.json`),
      size === 0 ? "" : $.fs.read(`${base}/events.jsonl`, { offset, length: size - offset }),
    ]);
    // A range starts inside a line, which is left out.
    const whole = offset === 0 ? eventsText : eventsText.slice(eventsText.indexOf("\n") + 1);
    return toView(dir, runId, JSON.parse(graphText) as Graph, parseEvents(whole));
  });
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "ayaito",
      description: "Show an ayaito run on its graph in a pane: /ayaito [runs dir] [run id]",
    });
    seen = "";
    // A read that fails (a file half written) is tried again at the next tick.
    $.clock.every(1500, () => void refresh($).catch(() => {}));
    await $.tool.register(RUN_SPEC);
    await $.tool.register(STOP_SPEC);
    await $.tool.register(STEER_SPEC);
    $.clock.every(2000, () => void watch($).catch(() => {}));

    return next(e);
  });

  on("tool.run", { tool: RUN }, async ($, e) => {
    const { dir } = await read($, source);
    const answer = await start($, dir, e as Record<string, unknown>);
    if ("result" in answer) {
      // The pane follows the run that last wrote, which is now this one.
      seen = "";
      void $.ui.open({ id: PANE, title: TITLE });
    }

    return answer;
  });

  on("tool.run", { tool: STOP }, async ($, e) => stop($, (await read($, source)).dir, e as Record<string, unknown>));

  on("tool.run", { tool: STEER }, async ($, e) => steer($, (await read($, source)).dir, e as Record<string, unknown>));

  on("command.run", { command: "ayaito" }, async ($, e) => {
    const [dir, runId] = e.args.trim().split(/\s+/).filter(Boolean);
    if (dir !== undefined) await update($, source, () => ({ dir, ...(runId !== undefined && { runId }) }));
    seen = "";
    await refresh($).catch(() => {});
    await $.ui.open({ id: PANE, title: TITLE });
    const now = await read($, source);

    return { text: `Showing ${now.runId ?? "the latest run"} of ${now.dir}.` };
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Progress } = $.ui.resolve(e);
    const v = await read($, shown);
    if (v.runId === undefined) return <Text dimColor>{v.note ?? `No runs in ${v.dir} yet.`}</Text>;

    // The run is as far as the nodes no group holds.
    const top = v.rows.filter((row) => row.depth === 0).map((row) => row.status);
    const state: Status =
      (["running", "failed", "stopped", "pending"] as const).find((status) => top.includes(status)) ?? "done";
    const LABEL: Record<Status, string> = {
      pending: "Waiting",
      running: "Running",
      done: "Done",
      failed: "Failed",
      skipped: "Done",
      stopped: "Stopped",
    };

    return (
      <Box flexDirection="column">
        <Text bold>
          {v.runId} <Text dimColor>{v.dir}</Text>
        </Text>
        <Progress
          label={LABEL[state]}
          value={v.done}
          max={Math.max(1, v.total)}
          valueText={`${v.done}/${v.total} steps${v.usd > 0 ? ` · ${money(v.usd)}` : ""}`}
          color={COLOR[state] ?? "success"}
        />
        <Box flexDirection="column" marginTop={1}>
          {v.rows.map((row) => (
            <Box flexDirection="column" paddingLeft={row.depth * 2}>
              <Text wrap="truncate-end">
                <Text color={COLOR[row.status]} dimColor={row.status === "pending" || row.status === "skipped"}>
                  {MARK[row.status]}
                </Text>{" "}
                {row.when !== undefined && <Text dimColor>{row.when}: </Text>}
                <Text
                  bold={row.kind !== "fn" && row.kind !== "agent"}
                  color={row.kind === "agent" ? "claude" : undefined}
                >
                  {row.kind === "choice" ? `◇ ${row.label}` : row.label}
                </Text>
                {row.detail !== "" && <Text dimColor> {row.detail}</Text>}
              </Text>
              {row.activity !== undefined && (
                <Box paddingLeft={2}>
                  <Text dimColor wrap="truncate-end">
                    {row.activity}
                  </Text>
                </Box>
              )}
              {row.error !== undefined && (
                <Box paddingLeft={2}>
                  <Text color="error" maxLines={3}>
                    {row.error}
                  </Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      </Box>
    );
  });
};
