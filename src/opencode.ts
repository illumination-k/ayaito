import { setTimeout as sleep } from "node:timers/promises";

import {
  type AssistantMessage,
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
  type Part,
  type PermissionRuleset,
  type ServerOptions,
} from "@opencode-ai/sdk/v2";

import { type Access, type AgentRuntime, defineRuntime, InterruptedError } from "./runtime.ts";

export interface OpencodeRuntimeOptions {
  /** URL of an `opencode serve` to use. Otherwise the runtime starts its own (needs `opencode` on PATH) and close stops it. */
  baseUrl?: string;
  server?: ServerOptions;
  agent?: string;
}

const allow = (...permissions: string[]): PermissionRuleset =>
  permissions.map((permission) => ({ permission, pattern: "*", action: "allow" }));
// Structured answers come back through the StructuredOutput tool, so it must stay allowed or the turn hangs.
const READ = ["read", "glob", "grep", "list", "StructuredOutput"];
// opencode applies the last rule that matches: deny all, then allow the listed permissions.
const PERMISSION: Record<Access, PermissionRuleset> = {
  "read-only": [{ permission: "*", pattern: "*", action: "deny" }, ...allow(...READ)],
  write: [{ permission: "*", pattern: "*", action: "deny" }, ...allow(...READ, "edit", "bash")],
};
const POLL_MS = 1000;

/** Runs calls through an opencode server, read-only unless the call asks for write. */
export function opencodeRuntime(options: OpencodeRuntimeOptions = {}): AgentRuntime {
  let connection: Promise<{ client: OpencodeClient; close(): void }> | undefined;
  const connect = () =>
    (connection ??= options.baseUrl
      ? Promise.resolve({ client: createOpencodeClient({ baseUrl: options.baseUrl }), close() {} })
      : // Port 0, so that runtimes of parallel nodes run side by side.
        createOpencodeServer({ port: 0, ...options.server }).then((server) => ({
          client: createOpencodeClient({ baseUrl: server.url }),
          close: () => server.close(),
        })));

  return defineRuntime({
    name: "opencode",
    async run(request) {
      const { client } = await connect();
      const directory = request.cwd ?? process.cwd();
      const permission = PERMISSION[request.access ?? "read-only"];
      const session = request.sessionId
        ? await client.session.update({ sessionID: request.sessionId, directory, permission }, { throwOnError: true })
        : await client.session.create({ directory, agent: options.agent, permission }, { throwOnError: true });
      const sessionID = session.data.id;
      const abort = () => void client.session.abort({ sessionID, directory });
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        const before = (await lastMessage(client, sessionID, directory))?.info.id;
        // promptAsync and polling, because session.prompt holds the response until the turn
        // ends and a long turn outlasts fetch's header timeout.
        await client.session.promptAsync(
          {
            sessionID,
            directory,
            agent: options.agent,
            model: request.model ? parseModel(request.model) : undefined,
            system: request.system,
            format: request.outputSchema && { type: "json_schema", schema: request.outputSchema },
            parts: [{ type: "text", text: request.prompt }],
          },
          { throwOnError: true, signal: request.signal },
        );
        const { info, parts } = await reply(client, sessionID, directory, before, request.signal);
        if (info.error) throw new Error(`opencode: ${info.error.name}: ${JSON.stringify(info.error.data)}`);
        return {
          text: parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""),
          structured: info.structured,
          sessionId: sessionID,
          costUsd: info.cost,
          models: {
            [`${info.providerID}/${info.modelID}`]: {
              input: info.tokens.input,
              output: info.tokens.output + info.tokens.reasoning,
              cacheRead: info.tokens.cache.read,
              cacheCreation: info.tokens.cache.write,
            },
          },
        };
      } catch (error) {
        if (request.signal?.aborted) throw new InterruptedError(sessionID, request.signal.reason);
        throw error;
      } finally {
        request.signal?.removeEventListener("abort", abort);
      }
    },
    async close() {
      if (connection) (await connection).close();
    },
  });
}

async function lastMessage(client: OpencodeClient, sessionID: string, directory: string) {
  const { data } = await client.session.messages({ sessionID, directory, limit: 1 }, { throwOnError: true });
  return data.at(-1);
}

/** Polls until the session is idle with a finished assistant message newer than before, and returns it. */
async function reply(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
  before: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ info: AssistantMessage; parts: Part[] }> {
  for (;;) {
    await sleep(POLL_MS, undefined, { signal });
    const { data: statuses } = await client.session.status({ directory }, { throwOnError: true });
    const status = statuses[sessionID];
    if (status && status.type !== "idle") continue;
    const last = await lastMessage(client, sessionID, directory);
    const info = last?.info;
    if (last && info?.role === "assistant" && info.id !== before && info.time.completed) {
      return { info, parts: last.parts };
    }
  }
}

function parseModel(model: string) {
  const slash = model.indexOf("/");
  if (slash <= 0) throw new Error(`opencode: expected a model as provider/model, not "${model}"`);
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
