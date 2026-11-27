import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type CanUseTool,
  createSdkMcpServer,
  type Options,
  query as sdkQuery,
  type SDKMessage,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";

import type { Tokens } from "./node.ts";
import { type Access, type AgentRuntime, brief, defineRuntime, InterruptedError, type Usage } from "./runtime.ts";

/** The SDK's query, or a stand-in for tests. interrupt, when there is one, ends the turn and keeps the session. */
export type Query = (params: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage> & { interrupt?(): Promise<unknown> };

export interface ClaudeRuntimeOptions extends Options {
  /**
   * Tools the agent may call besides the built-in ones, which makes a call a ReAct loop over
   * them. They are served as the in-process MCP server "ayaito" (`mcp__ayaito__<tool>`).
   */
  mcpTools?: SdkMcpToolDefinition<any>[];
}

export const defaultOptions: Options = {
  model: "claude-opus-5-5",
  // AGENTS.md / CLAUDE.md and the skills of the repository, not the user's settings.
  settingSources: ["project"],
};

const READ = ["Read", "Glob", "Grep"];
// Waits this long for an interrupted turn to end before stopping the process.
const INTERRUPT_MS = 10_000;
const TOOLS: Record<Access, string[]> = { "read-only": READ, write: [...READ, "Edit", "Write", "Bash"] };
const EDIT = new Set(["Edit", "Write"]);

/**
 * Runs calls through the Claude Agent SDK with options (allowedTools, permissionMode,
 * maxBudgetUsd, maxTurns, ...). A request sets cwd, model, the system prompt and the
 * session; its access, when it has one, replaces the tools and permissions.
 */
export function claudeRuntime({ mcpTools, ...base }: ClaudeRuntimeOptions = {}, query: Query = sdkQuery): AgentRuntime {
  return defineRuntime({
    name: "claude",
    async run(request) {
      request.signal?.throwIfAborted();
      const abortController = new AbortController();
      const options: Options = { ...defaultOptions, env: childEnv(), ...base, abortController };
      if (request.cwd) options.cwd = request.cwd;
      if (request.model) options.model = request.model;
      if (request.system) options.systemPrompt = request.system;
      if (request.sessionId) options.resume = request.sessionId;
      if (request.access === "read-only") {
        options.tools = READ;
        options.allowedTools = READ;
        // dontAsk, not bypassPermissions: Claude Code will not bypass as root (as in many containers).
        options.permissionMode = "dontAsk";
      } else if (request.access === "write") {
        options.tools = TOOLS.write;
        // Edit and Write are left to canUseTool. dontAsk refuses every edit under a .claude
        // directory, whatever allowedTools says, so it cannot work in a worktree kept there.
        options.allowedTools = TOOLS.write.filter((tool) => !EDIT.has(tool));
        options.permissionMode = "default";
        options.canUseTool ??= confine(options.cwd ?? process.cwd(), TOOLS.write);
      }
      if (mcpTools?.length) {
        options.mcpServers = { ...options.mcpServers, ayaito: createSdkMcpServer({ name: "ayaito", tools: mcpTools }) };
        options.allowedTools = [...(options.allowedTools ?? []), "mcp__ayaito"];
      }
      if (request.outputSchema) options.outputFormat = { type: "json_schema", schema: request.outputSchema };

      let result: Extract<SDKMessage, { type: "result" }> | undefined;
      let sessionId: string | undefined;
      const turn = query({ prompt: request.prompt, options });
      // Interrupting ends the turn with a result that carries its usage, and the session keeps
      // what was done; aborting, the fallback, kills the process.
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        fallback = setTimeout(() => abortController.abort(), INTERRUPT_MS);
        if (turn.interrupt) turn.interrupt().catch(() => abortController.abort());
        else abortController.abort();
      };
      request.signal?.addEventListener("abort", stop, { once: true });
      try {
        for await (const message of turn) {
          if (sessionId === undefined && message.session_id) request.onSession?.(message.session_id);
          sessionId ??= message.session_id;
          if (message.type === "result") result = message;
          else if (message.type === "assistant" && request.onActivity) {
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim() !== "") request.onActivity({ text: block.text });
              else if (block.type === "tool_use") request.onActivity({ tool: block.name, text: brief(block.input) });
            }
          }
        }
      } catch (error) {
        if (!request.signal?.aborted) throw error;
      } finally {
        clearTimeout(fallback);
        request.signal?.removeEventListener("abort", stop);
      }
      if (request.signal?.aborted) {
        if (sessionId === undefined) throw request.signal.reason;
        throw new InterruptedError(sessionId, request.signal.reason, result && usage(result));
      }
      if (!result) throw new Error("claude: no result message");
      if (result.subtype !== "success") throw new Error(`claude: ${result.subtype}: ${result.errors.join("; ")}`);
      // A request the API turned down (an invalid schema, for one) reports success with is_error set.
      if (result.is_error) throw new Error(`claude: ${result.result}`);
      return {
        text: result.result,
        structured: result.structured_output,
        sessionId: result.session_id,
        ...usage(result),
      };
    },
  });
}

/**
 * Answers every permission request of a write-access call, as nothing answers a prompt in an
 * unattended run: the access level's tools and ayaito's own are allowed, Edit and Write only for
 * a file whose real path (symlinks resolved) is inside cwd, and everything else is denied.
 */
export function confine(cwd: string, tools: string[]): CanUseTool {
  const root = realPath(resolve(cwd));
  return async (toolName, input) => {
    if (EDIT.has(toolName)) {
      const file = typeof input.file_path === "string" ? input.file_path : undefined;
      if (file === undefined) return { behavior: "deny", message: `${toolName}: no file_path` };
      const rel = relative(root, realPath(resolve(root, file)));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return { behavior: "deny", message: `${toolName}: ${file} is outside the working directory ${cwd}` };
      }
      return { behavior: "allow", updatedInput: input };
    }
    if (tools.includes(toolName) || toolName.startsWith("mcp__ayaito__")) {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `${toolName} is not allowed with write access` };
  };
}

/** The real path of a file that may not exist yet: that of its nearest existing ancestor, plus the rest. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

function usage(result: Extract<SDKMessage, { type: "result" }>): Usage {
  return {
    costUsd: result.total_cost_usd,
    models: Object.fromEntries(
      Object.entries(result.modelUsage ?? {}).map(([model, u]): [string, Tokens] => [
        model,
        {
          input: u.inputTokens,
          output: u.outputTokens,
          cacheRead: u.cacheReadInputTokens,
          cacheCreation: u.cacheCreationInputTokens,
        },
      ]),
    ),
  };
}

/**
 * The environment without the session of a Claude Code that runs this process: inherited, it
 * gives every call that session's id, so that parallel calls and resumes share one session.
 */
function childEnv(): Record<string, string | undefined> {
  return { ...process.env, CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_REMOTE_SESSION_ID: undefined };
}
