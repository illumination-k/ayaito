import { expect, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";

const PANE = {
  plugin: "ayaito",
  component: "Pane",
  requestId: "ayaito",
  props: {
    title: "ayaito run",
    isFocused: false,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const;

// toGraph of: Flow "weekly" -> prepare -> select topic (agent, checkpoint) -> branch "ok?" -> ship | fix
const GRAPH = {
  nodes: [
    { id: "in", kind: "input", label: "input" },
    { id: "s0", kind: "flow", label: "weekly", name: "weekly" },
    { id: "n1", kind: "fn", label: "prepare", name: "prepare", parent: "s0" },
    { id: "n2", kind: "agent", label: "select topic", name: "select topic", assign: "topic", parent: "s0" },
    { id: "c3", kind: "choice", label: "ok?", name: "ok?", parent: "s0" },
    { id: "n4", kind: "fn", label: "ship", name: "ship", parent: "s0" },
    { id: "n5", kind: "fn", label: "fix", name: "fix", parent: "s0" },
    { id: "out", kind: "output", label: "output" },
  ],
  edges: [
    { from: "in", to: "n1" },
    { from: "n1", to: "n2", use: ["checkpoint"] },
    { from: "n2", to: "c3" },
    { from: "c3", to: "n4", when: "yes" },
    { from: "c3", to: "n5", when: "no" },
    { from: "n4", to: "out" },
    { from: "n5", to: "out" },
  ],
};

/** The person typing /ayaito. */
const typed = (args: string) =>
  ({
    command: "ayaito",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 120 },
  }) as const;

const EVENTS = [
  { type: "start", node: "weekly" },
  { type: "start", node: "prepare" },
  { type: "end", node: "prepare", ms: 12 },
  { type: "start", node: "select topic" },
  { type: "usage", node: "select topic", usd: 0.25, models: {} },
  { type: "end", node: "select topic", ms: 4200 },
  { type: "start", node: "ok?" },
  { type: "start", node: "fix" },
  { type: "error", node: "fix", error: "Error: boom" },
  { type: "start", node: "fix" },
];

/** Stands for the disk: the runs of `.runs`, one of them older. */
const disk = (on: Parameters<TestBody>[1], events: object[]) => {
  const text = `${events.map((e) => JSON.stringify(e)).join("\n")}\n{"type":"sta`;
  const stat = (size: number, mtimeMs: number) => ({ value: { kind: "file" as const, size, mtimeMs, isLink: false } });
  on("fs.list", () => ({
    value: ["old", "r1"].map((name) => ({ name, kind: "dir" as const, size: 0, mtimeMs: 0, isLink: false })),
  }));
  on("fs.stat", (_, e) => {
    if (e.path.endsWith("old/events.jsonl")) return stat(1, 100);
    if (e.path.endsWith("r1/events.jsonl")) return stat(text.length, 200);
    if (e.path.endsWith("r1/graph.json")) return stat(1, 150);
    throw new Error(`ENOENT ${e.path}`);
  });
  on("fs.read", (_, e) => ({ value: e.path.endsWith("graph.json") ? JSON.stringify(GRAPH) : text }));
  on("command.register", () => ({ value: { command: "ayaito" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
};

test("the pane shows the latest run on its graph, on every surface", async ($, on) => {
  disk(on, EVENTS);
  const { text } = await $.command.run(typed(""));
  expect(text).toBe("Showing the latest run of .runs.");

  for (const surface of ["terminal", "desktop", "vscode", "mobile"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const line = async (label: RegExp) => (await ui.find({ type: "Text", text: label }))?.text;

    expect(await line(/^r1/)).toBe("r1 .runs");
    expect(await line(/prepare/)).toBe("✓ prepare 12ms");
    expect(await line(/select topic/)).toBe("✓ select topic → topic · checkpoint · 4.2s · $0.250");
    expect(await line(/ok\?/)).toBe("● ◇ ok?");
    expect(await line(/ship/)).toBe("○ yes: ship");
    // It failed, then started again: it runs, and the error of the earlier run is gone.
    expect(await line(/fix/)).toBe("● no: fix ×2");
    expect(await ui.find({ type: "Text", text: /boom/ })).toBeUndefined();
    expect(await ui.find({ text: /Running.*2\/4 steps · \$0\.250/ })).toBeDefined();
    await ui.unmount();
  }
});

test("a node that failed shows its error", async ($, on) => {
  // An error is recorded by each node it passes through.
  const failed = ["ok?", "weekly"].map((node) => ({ type: "error", node, error: "Error: boom" }));
  disk(on, [...EVENTS.slice(0, 9), ...failed]);
  await $.command.run(typed(""));
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  expect((await ui.find({ type: "Text", text: /fix/ }))?.text).toBe("✗ no: fix");
  expect((await ui.find({ type: "Text", text: /boom/ }))?.text).toBe("Error: boom");
  expect(await ui.find({ text: /Failed.*2\/4 steps/ })).toBeDefined();
  await ui.unmount();
});

test("a folder with no runs says so", async ($, on) => {
  on("fs.list", () => {
    throw new Error("ENOENT");
  });
  on("command.register", () => ({ value: { command: "ayaito" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  await $.command.run(typed("out/runs"));
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await ui.find({ type: "Text" }))?.text).toBe("No runs in out/runs yet.");
  await ui.unmount();
});

const WORKING = [
  { type: "start", node: "weekly" },
  { type: "start", node: "select topic" },
  { type: "activity", node: "select topic", text: "I will look\nat the site." },
  { type: "activity", node: "select topic", tool: "Read", text: '{"file_path":"a.md"}' },
];

test("an agent that is running shows the last thing it said or did", async ($, on) => {
  disk(on, WORKING);
  await $.command.run(typed(""));
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  expect((await ui.find({ type: "Text", text: /Read/ }))?.text).toBe('Read {"file_path":"a.md"}');
  expect(await ui.find({ type: "Text", text: /I will look/ })).toBeUndefined();
});

test("an agent that was sent a message shows it", async ($, on) => {
  disk(on, [...WORKING, { type: "steer", node: "select topic", message: "Pick something seasonal." }]);
  await $.command.run(typed(""));
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  expect((await ui.find({ type: "Text", text: /seasonal/ }))?.text).toBe("← Pick something seasonal.");
});
