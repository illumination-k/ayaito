import { expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";

type On = Parameters<TestBody>[1];

/** Stands for the project: its files, the processes started in it, and what was said to Claude. */
const project = (on: On, files: Record<string, string>) => {
  const world = {
    files,
    started: [] as string[][],
    steered: [] as string[][],
    killed: [] as string[],
    said: [] as string[],
    alive: true,
  };
  const name = (path: string) => Object.keys(files).find((file) => path.endsWith(file));
  on("fs.exists", (_, e) => ({ value: name(e.path) !== undefined }));
  on("fs.read", (_, e) => {
    const file = name(e.path);
    return { value: file === undefined ? "{}" : (files[file] ?? "") };
  });
  on("fs.write", (_, e) => {
    files[e.path.slice(e.path.indexOf(".runs/"))] = e.text;
    return { value: undefined };
  });
  on("fs.list", () => ({ value: [] }));
  on("process.run", (_, e) => {
    const done = (exitCode: number, stdout = "") => ({
      value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
    });
    if (e.argv[0] === "sh") {
      world.started.push(e.argv.slice(3));
      return done(0, "4242\n");
    }
    if (e.argv[1] === "stop") {
      world.steered.push(e.argv);
      return done(0, "Told.\n");
    }
    if (e.argv[1] === "steer") {
      world.steered.push(e.argv);
      return e.argv.at(-2) === "plan" ? done(0, "Sent.\n") : { value: { ...done(1).value, stderr: "not running" } };
    }
    if (e.argv[1] === "-0") return done(world.alive ? 0 : 1);
    world.killed.push(e.argv[1] ?? "");
    return done(0);
  });
  on("prompt.submit", (_, e) => {
    world.said.push(e.text);
    return { text: e.text };
  });
  on("command.register", () => ({ value: { command: "ayaito" } }));
  on("tool.register", (_, e) => ({ value: { tool: `mcp__ayaito__${e.name}` } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  return world;
};

const INSTALLED = { "node_modules/.bin/ayaito": "" };
const SCRIPT = "export default flow";

test("the run tool saves the flow, starts it apart from the mod and tells Claude when it ends", async ($, on) => {
  const clock = mock.clock(on);
  const world = project(on, { ...INSTALLED });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });

  const { result } = await $.tool.call({ tool: "mcp__ayaito__run", name: "fix all", script: SCRIPT, input: { n: 1 } });
  const runId = /Started run (\S+)/.exec(String(result))?.[1] ?? "";
  expect(runId).toMatch(/^fix-all-/);
  const base = `.runs/${runId}`;
  expect(world.files[`${base}/flow.ts`]).toBe(SCRIPT);
  expect(world.files[`${base}/input.json`]).toBe('{"n":1}');
  expect(world.started).toEqual([
    [`${base}/run.log`, "node_modules/.bin/ayaito", "run", `${base}/flow.ts`, "--run-id", runId, "--store", ".runs", "--input-file", `${base}/input.json`], // prettier-ignore
  ]);

  // While it goes on, nothing is said, and the same run is not started twice.
  await clock.advance(5000);
  expect(world.said).toEqual([]);
  expect((await $.tool.call({ tool: "mcp__ayaito__run", runId })).text).toMatch(/still going/);

  world.files[`${base}/result.json`] = '{"status":"done","output":2}';
  await clock.advance(5000);
  await clock.advance(5000);
  expect(world.said).toHaveLength(1);
  expect(world.said[0]).toContain(`ayaito run ${runId} ended.`);
  expect(world.said[0]).toContain('{"status":"done","output":2}');
});

test("a run that ends without a result is told with its log", async ($, on) => {
  const clock = mock.clock(on);
  const world = project(on, { ...INSTALLED });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  const { result } = await $.tool.call({ tool: "mcp__ayaito__run", name: "bad", script: SCRIPT });
  const runId = /Started run (\S+)/.exec(String(result))?.[1] ?? "";

  world.files[`.runs/${runId}/run.log`] = "SyntaxError: Unexpected token";
  world.alive = false;
  await clock.advance(5000);
  expect(world.said).toEqual([
    `ayaito run ${runId} ended without a result. Its log (.runs/${runId}/run.log):\nSyntaxError: Unexpected token`,
  ]);
});

test("the stop tool ends the run and says nothing more of it", async ($, on) => {
  const clock = mock.clock(on);
  const world = project(on, { ...INSTALLED });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  const { result } = await $.tool.call({ tool: "mcp__ayaito__run", name: "long", script: SCRIPT });
  const runId = /Started run (\S+)/.exec(String(result))?.[1] ?? "";

  expect(String((await $.tool.call({ tool: "mcp__ayaito__stop", runId })).result)).toContain(`Stopped run ${runId}`);
  expect(world.killed).toEqual(["4242"]);
  world.alive = false;
  await clock.advance(5000);
  expect(world.said).toEqual([]);

  // Its flow is saved: the id alone runs it again.
  expect(String((await $.tool.call({ tool: "mcp__ayaito__run", runId })).result)).toContain(`Started run ${runId}`);
});

test("without ayaito in the project the run tool says how to install it", async ($, on) => {
  project(on, {});
  const answer = await $.tool.call({ tool: "mcp__ayaito__run", name: "x", script: SCRIPT });

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/npm install ayaito/);
});

test("the steer tool passes the message to the run through the CLI and says why it could not", async ($, on) => {
  const world = project(on, { ...INSTALLED });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });

  const sent = await $.tool.call({ tool: "mcp__ayaito__steer", runId: "r1", node: "plan", message: "-- fewer tasks" });
  expect(sent.result).toBe("Sent.");
  expect(world.steered).toEqual([
    ["node_modules/.bin/ayaito", "steer", "--store", ".runs", "--", "r1", "plan", "-- fewer tasks"],
  ]);

  const refused = await $.tool.call({ tool: "mcp__ayaito__steer", runId: "r1", node: "fix", message: "stop" });
  expect(refused.isError).toBe(true);
  expect(refused.text).toMatch(/not running/);
  expect((await $.tool.call({ tool: "mcp__ayaito__steer", runId: "r1", node: "plan" })).text).toMatch(/Pass runId/);
});

test("the stop tool with a node stops only its agent, through the CLI", async ($, on) => {
  const world = project(on, { ...INSTALLED });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });

  expect((await $.tool.call({ tool: "mcp__ayaito__stop", runId: "r1", node: "plan" })).result).toBe("Told.");
  expect(world.steered).toEqual([["node_modules/.bin/ayaito", "stop", "--store", ".runs", "--", "r1", "plan"]]);
  expect(world.killed).toEqual([]);
});
