import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  type AgentCapabilities,
  client,
  type ClientApp,
  type ClientConnection,
  type LoadSessionRequest,
  type McpServer,
  methods,
  ndJsonStream,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOptionKind,
  PROTOCOL_VERSION,
  type RequestPermissionResponse,
  type ToolKind,
} from "@agentclientprotocol/sdk/unstable";

import type { Tokens } from "./node.ts";
import {
  type Access,
  type Activity,
  type AgentRuntime,
  defineRuntime,
  InterruptedError,
  OutputError,
} from "./runtime.ts";

export interface AcpRuntimeOptions {
  /** The agent to start, which speaks ACP on its stdio. */
  command: string;
  args?: string[];
  /** Added to the environment of this process. */
  env?: Record<string, string>;
  /** MCP servers every session gets. */
  mcpServers?: McpServer[];
  /**
   * Sent as `_meta` when a session is made or resumed, for settings only this agent
   * understands (the Claude adapter reads `claudeCode.options`, for one).
   */
  meta?: Record<string, unknown>;
}

/** Opens the connection to the agent. Replaced in tests by one to an agent in this process. */
export type Connect = (app: ClientApp) => { connection: ClientConnection; close(): void };

// Tool calls without a kind count as "other".
const READ: ReadonlySet<ToolKind> = new Set(["read", "search", "think"]);

interface Session {
  access: Access;
  /** The id and the current value of the config option that selects the model. */
  model?: { id: string; value: unknown };
  /** The agent's message since the last tool call: what is left at the end of a turn is its answer. */
  text: string;
  afterTool: boolean;
  /** The cost of the session so far, as the agent reports it. */
  costUsd?: number;
  /** The onActivity of the call in progress. */
  onActivity?: (activity: Activity) => void;
}

/** Reports the message so far, once: before the tool call that follows it, or when the turn ends. */
function said(session: Session) {
  if (!session.afterTool && session.text.trim() !== "") session.onActivity?.({ text: session.text });
}

/**
 * Runs calls on an agent that speaks the Agent Client Protocol, started as a child process
 * and shared by all calls. ACP agents ask the client before they act, and access answers
 * for it: read-only (the default) allows reading and searching and refuses the rest. An
 * agent started in a mode that does not ask is not held back, so leave it in its default
 * mode. ACP has no structured output: the schema goes into the prompt and the answer is
 * parsed from the text. Usage has what the agent reports: the cost when it is in USD, and the
 * tokens of the turn.
 */
export function acpRuntime(options: AcpRuntimeOptions, connect: Connect = (app) => start(app, options)): AgentRuntime {
  const sessions = new Map<string, Session>();
  const mcpServers = options.mcpServers ?? [];
  const meta = options.meta && { _meta: options.meta };

  const app = client({ name: "ayaito" })
    .onNotification(methods.client.session.update, ({ params: { sessionId, update } }) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        if (session.afterTool) session.text = "";
        session.afterTool = false;
        session.text += update.content.text;
      } else if (update.sessionUpdate === "tool_call") {
        said(session);
        session.afterTool = true;
        session.onActivity?.({ tool: update.kind ?? "tool", text: update.title });
      } else if (update.sessionUpdate === "usage_update" && update.cost?.currency === "USD") {
        session.costUsd = update.cost.amount;
      } else if (update.sessionUpdate === "config_option_update") {
        session.model = modelOption(update.configOptions);
      }
    })
    .onRequest(methods.client.session.requestPermission, ({ params }): RequestPermissionResponse => {
      const access = sessions.get(params.sessionId)?.access ?? "read-only";
      const allowed = access === "write" || READ.has(params.toolCall.kind ?? "other");
      const kinds: PermissionOptionKind[] = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
      const option = kinds.flatMap((kind) => params.options.filter((o) => o.kind === kind))[0];
      return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
    });

  let connected: Promise<{ connection: ClientConnection; close(): void; capabilities: AgentCapabilities }> | undefined;
  const open = () =>
    (connected ??= (async () => {
      const opened = connect(app);
      const close = () => opened.close();
      const connection = opened.connection;
      try {
        const { agentCapabilities } = await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "ayaito", version: "0" },
        });
        return { connection, close, capabilities: agentCapabilities ?? {} };
      } catch (error) {
        close();
        throw error;
      }
    })());

  return defineRuntime({
    name: "acp",
    async run(request) {
      request.signal?.throwIfAborted();
      const { connection, capabilities } = await open();
      const agent = connection.agent;
      const cwd = request.cwd ?? process.cwd();
      const access = request.access ?? "read-only";
      // Where the agent takes no system prompt, it leads the first prompt of the session.
      const takesSystem = Boolean(capabilities.sessionCapabilities?.systemPrompt);
      const system: Pick<NewSessionRequest, "systemPrompt"> =
        request.system && takesSystem
          ? { systemPrompt: { mode: "append", content: [{ type: "text", text: request.system }] } }
          : {};
      let prompt = request.prompt;

      let session: Session;
      let sessionId: string;
      const live = request.sessionId === undefined ? undefined : sessions.get(request.sessionId);
      if (live && request.sessionId !== undefined) {
        session = live;
        sessionId = request.sessionId;
        session.access = access;
      } else {
        session = { access, text: "", afterTool: false };
        let configOptions: NewSessionResponse["configOptions"];
        if (request.sessionId === undefined) {
          const params: NewSessionRequest = { cwd, mcpServers, ...system, ...meta };
          const response = await agent.request(methods.agent.session.new, params);
          sessionId = response.sessionId;
          configOptions = response.configOptions;
          if (request.system && !takesSystem) prompt = `${request.system}\n\n${prompt}`;
        } else {
          // A session of an earlier process.
          sessionId = request.sessionId;
          const resume = capabilities.sessionCapabilities?.resume;
          if (!resume && !capabilities.loadSession) {
            throw new Error(`acp: the agent cannot resume session ${sessionId}`);
          }
          const params: LoadSessionRequest = { sessionId, cwd, mcpServers, ...system, ...meta };
          // Tracked before the request, to count the usage that comes with the session.
          sessions.set(sessionId, session);
          try {
            const response = resume
              ? await agent.request(methods.agent.session.resume, params)
              : await agent.request(methods.agent.session.load, params);
            configOptions = response.configOptions;
          } catch (error) {
            sessions.delete(sessionId);
            throw error;
          }
        }
        sessions.set(sessionId, session);
        session.model ??= modelOption(configOptions);
      }

      if (request.model !== undefined && request.model !== session.model?.value) {
        if (!session.model) throw new Error(`acp: the agent has no model option to set "${request.model}" with`);
        const configId = session.model.id;
        await agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value: request.model });
        session.model = { id: configId, value: request.model };
      }
      if (request.outputSchema) {
        prompt += `\n\nAnswer with only a JSON value that matches this JSON Schema, and no other text:\n${JSON.stringify(request.outputSchema)}`;
      }

      session.text = "";
      session.afterTool = false;
      session.onActivity = request.onActivity;
      const costBefore = session.costUsd ?? 0;
      let models: Record<string, Tokens> | undefined;
      const cancel = () => void agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
      request.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const { stopReason, usage } = await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        said(session);
        if (stopReason === "cancelled" && request.signal?.aborted) {
          const costUsd = session.costUsd === undefined ? undefined : session.costUsd - costBefore;
          throw new InterruptedError(sessionId, request.signal.reason, { costUsd });
        }
        if (stopReason !== "end_turn") throw new Error(`acp: the turn ended with ${stopReason}`);
        // Still unstable in ACP, so only some agents send it. Thought tokens count as output, as on opencode.
        if (usage) {
          const model = request.model ?? (typeof session.model?.value === "string" ? session.model.value : "acp");
          models = {
            [model]: {
              input: usage.inputTokens,
              output: usage.outputTokens + (usage.thoughtTokens ?? 0),
              cacheRead: usage.cachedReadTokens ?? 0,
              cacheCreation: usage.cachedWriteTokens ?? 0,
            },
          };
        }
      } finally {
        session.onActivity = undefined;
        request.signal?.removeEventListener("abort", cancel);
      }

      const text = session.text;
      const costUsd = session.costUsd === undefined ? undefined : session.costUsd - costBefore;
      let structured: unknown;
      if (request.outputSchema) {
        try {
          structured = parseJson(text);
        } catch {
          throw new OutputError(sessionId, "- (root): the answer could not be parsed as JSON", { costUsd, models });
        }
      }
      return { text, structured, sessionId, costUsd, models };
    },
    async close() {
      const current = connected;
      connected = undefined;
      sessions.clear();
      // A connection that never opened has nothing to close.
      (await current?.catch(() => undefined))?.close();
    },
  });
}

function start(app: ClientApp, { command, args = [], env }: AcpRuntimeOptions) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
  const connection = app.connect(
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  );
  // Without these a call would wait forever for an agent that is gone.
  child.once("error", (error) => connection.close(error));
  child.once("exit", (code, signal) => connection.close(new Error(`acp: ${command} exited (${signal ?? code})`)));
  return {
    connection,
    close() {
      connection.close();
      child.kill();
    },
  };
}

function modelOption(options: NewSessionResponse["configOptions"]): Session["model"] {
  const option = options?.find((o) => o.category === "model" && o.type === "select");
  return option && { id: option.id, value: option.currentValue };
}

/** The JSON of an answer that may wrap it in a code fence or in a sentence around it. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
    if (fenced !== undefined) return JSON.parse(fenced);
    const start = text.search(/[{[]/);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    return JSON.parse(text.slice(start, end + 1));
  }
}
