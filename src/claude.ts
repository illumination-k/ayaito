import {
  createSdkMcpServer,
  type Options,
  query as sdkQuery,
  type SDKMessage,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";

import type { Tokens } from "./node.ts";
import { type Access, type AgentRuntime, defineRuntime } from "./runtime.ts";

export type Query = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

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
const TOOLS: Record<Access, string[]> = { "read-only": READ, write: [...READ, "Edit", "Write", "Bash"] };

/**
 * Runs calls through the Claude Agent SDK with options (allowedTools, permissionMode,
 * maxBudgetUsd, maxTurns, ...). A request sets cwd, model, the system prompt and the
 * session; its access, when it has one, replaces the tools and permissions.
 */
export function claudeRuntime({ mcpTools, ...base }: ClaudeRuntimeOptions = {}, query: Query = sdkQuery): AgentRuntime {
  return defineRuntime({
    name: "claude",
    async run(request) {
      const abortController = new AbortController();
      request.signal?.addEventListener("abort", () => abortController.abort(), { once: true });
      const options: Options = { ...defaultOptions, ...base, abortController };
      if (request.cwd) options.cwd = request.cwd;
      if (request.model) options.model = request.model;
      if (request.system) options.systemPrompt = request.system;
      if (request.sessionId) options.resume = request.sessionId;
      if (request.access) {
        options.tools = TOOLS[request.access];
        options.allowedTools = TOOLS[request.access];
        // dontAsk, not bypassPermissions: Claude Code will not bypass as root (as in many containers).
        options.permissionMode = "dontAsk";
      }
      if (mcpTools?.length) {
        options.mcpServers = { ...options.mcpServers, ayaito: createSdkMcpServer({ name: "ayaito", tools: mcpTools }) };
        options.allowedTools = [...(options.allowedTools ?? []), "mcp__ayaito"];
      }
      if (request.outputSchema) options.outputFormat = { type: "json_schema", schema: request.outputSchema };

      let result: Extract<SDKMessage, { type: "result" }> | undefined;
      for await (const message of query({ prompt: request.prompt, options })) {
        if (message.type === "result") result = message;
      }
      if (!result) throw new Error("claude: no result message");
      if (result.subtype !== "success") throw new Error(`claude: ${result.subtype}: ${result.errors.join("; ")}`);
      // A request the API turned down (an invalid schema, for one) reports success with is_error set.
      if (result.is_error) throw new Error(`claude: ${result.result}`);
      return {
        text: result.result,
        structured: result.structured_output,
        sessionId: result.session_id,
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
    },
  });
}
