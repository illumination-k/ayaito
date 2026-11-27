import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { opencodeRuntime } from "../src/opencode.ts";
import { type AgentRuntime, InterruptedError } from "../src/runtime.ts";

interface Request {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
}

interface Turn {
  parts?: object[];
  error?: object;
  structured?: unknown;
  /** Polls the session stays busy for before it answers. */
  busy?: number;
  /** Never answers. */
  hangs?: boolean;
}

const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } };

/** An opencode server in this process that plays turns and records what it was sent. */
async function fakeServer(turns: Turn[]) {
  const seen: Request[] = [];
  const messages = new Map<string, { info: Record<string, unknown>; parts: object[] }[]>();
  let busy = 0;
  let id = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      seen.push({ method: req.method ?? "", path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      const send = (data: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const [, , sessionID, action] = url.pathname.split("/");
      if (req.method === "POST" && url.pathname === "/session") {
        const session = `ses${++id}`;
        messages.set(session, []);
        return send({ id: session });
      }
      if (url.pathname === "/session/status") {
        return send(busy > 0 ? (busy--, { ses1: { type: "busy" } }) : {});
      }
      if (sessionID === undefined) return send({});
      const list = messages.get(sessionID) ?? [];
      messages.set(sessionID, list);
      if (req.method === "PATCH" && action === undefined) return send({ id: sessionID });
      if (action === "message") return send(list.slice(-Number(url.searchParams.get("limit") ?? list.length)));
      if (action === "abort") return send(true);
      if (action === "prompt_async") {
        const turn = turns.shift() ?? {};
        list.push({ info: { id: `u${list.length}`, role: "user" }, parts: [] });
        busy = turn.busy ?? 0;
        if (!turn.hangs) {
          list.push({
            info: {
              id: `a${list.length}`,
              role: "assistant",
              time: { created: 0, completed: 1 },
              providerID: "prov",
              modelID: "mod",
              cost: 0.25,
              tokens,
              structured: turn.structured,
              error: turn.error,
            },
            parts: turn.parts ?? [],
          });
        } else busy = Number.POSITIVE_INFINITY;
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  const runtime = opencodeRuntime({ baseUrl: `http://127.0.0.1:${port}`, agent: "build" });
  runtimes.push(runtime);
  const sent = (method: string, path: string) => seen.filter((r) => r.method === method && r.path === path);
  return { runtime, sent };
}

const servers: ReturnType<typeof createServer>[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const server of servers.splice(0)) server.close();
});

const text = (id: string, value: string, extra: object = {}) => ({
  id,
  type: "text",
  text: value,
  time: { start: 0, end: 1 },
  ...extra,
});

describe("opencodeRuntime", () => {
  it("starts a read-only session and answers with its text, structured output and usage", async () => {
    const { runtime, sent } = await fakeServer([
      { parts: [text("p1", '{"topic":'), text("p2", '"a"}')], structured: { topic: "a" }, busy: 1 },
    ]);
    const sessions: string[] = [];

    const answer = await runtime.run({
      prompt: "pick",
      system: "sys",
      model: "prov/mod-1",
      cwd: "/work",
      output: z.object({ topic: z.string() }),
      onSession: (id) => sessions.push(id),
    });

    expect(answer).toMatchObject({
      text: '{"topic":"a"}',
      structured: { topic: "a" },
      sessionId: "ses1",
      costUsd: 0.25,
      models: { "prov/mod": { input: 10, output: 7, cacheRead: 3, cacheCreation: 1 } },
    });
    expect(sessions).toEqual(["ses1"]);
    const [created] = sent("POST", "/session");
    expect(created?.query.directory).toBe("/work");
    expect(created?.body).toMatchObject({ agent: "build" });
    const permission = created?.body?.permission as { permission: string; action: string }[];
    expect(permission[0]).toEqual({ permission: "*", pattern: "*", action: "deny" });
    expect(permission.map((p) => p.permission)).not.toContain("edit");
    expect(permission.map((p) => p.permission)).toContain("StructuredOutput");
    const [prompt] = sent("POST", "/session/ses1/prompt_async");
    expect(prompt?.body).toMatchObject({
      agent: "build",
      model: { providerID: "prov", modelID: "mod-1" },
      system: "sys",
      format: { type: "json_schema" },
      parts: [{ type: "text", text: expect.stringMatching(/^pick/) }],
    });
  });

  it("resumes a session with write access and reports the turn's parts once each", async () => {
    const { runtime, sent } = await fakeServer([
      {
        parts: [
          text("t1", "Looking."),
          text("t2", "  "),
          text("t3", "hidden", { synthetic: true }),
          { id: "k1", type: "tool", tool: "bash", state: { status: "completed", title: "ls", input: {} } },
          { id: "k2", type: "tool", tool: "read", state: { status: "running", input: { path: "a.ts" } } },
          { id: "k3", type: "tool", tool: "edit", state: { status: "pending", input: {} } },
          { id: "s1", type: "step-start" },
        ],
      },
    ]);
    const seen: unknown[] = [];

    const answer = await runtime.run({
      prompt: "go",
      sessionId: "old",
      access: "write",
      onActivity: (activity) => seen.push(activity),
    });

    expect(answer).toMatchObject({ sessionId: "old", text: "Looking.  hidden" });
    expect(seen).toEqual([
      { text: "Looking." },
      { tool: "bash", text: "ls" },
      { tool: "read", text: '{"path":"a.ts"}' },
    ]);
    const [updated] = sent("PATCH", "/session/old");
    const permission = updated?.body?.permission as { permission: string }[];
    expect(permission.map((p) => p.permission)).toEqual(expect.arrayContaining(["edit", "bash"]));
    expect(sent("POST", "/session")).toEqual([]);
  });

  it("throws the error of the answer, and on a model without a provider", async () => {
    const { runtime } = await fakeServer([{ error: { name: "ProviderAuthError", data: { message: "no key" } } }]);
    await expect(runtime.run({ prompt: "" })).rejects.toThrow('opencode: ProviderAuthError: {"message":"no key"}');
    await expect(runtime.run({ prompt: "", model: "mod" })).rejects.toThrow(
      'opencode: expected a model as provider/model, not "mod"',
    );
  });

  it("aborts the session and throws InterruptedError when the signal aborts", async () => {
    const { runtime, sent } = await fakeServer([{ hangs: true }]);
    const controller = new AbortController();
    const running = runtime.run({ prompt: "", signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stopped")), 100);
    const error = await running.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InterruptedError);
    expect(error).toMatchObject({ sessionId: "ses1", message: "stopped" });
    // The abort is sent without waiting for it.
    await vi.waitFor(() => expect(sent("POST", "/session/ses1/abort")).toHaveLength(1));
  });
});
