import {
  createSdkMcpServer,
  query as sdkQuery,
  type Options,
  type SDKMessage,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Node } from "./node.ts";

export interface AgentConfig<I, O> {
  /** The task, built from the node's input. */
  prompt: (input: I) => string;
  /** The output the agent must return; it is the node's output after validation. */
  output: z.ZodType<O>;
  /**
   * Tools the agent may call besides the built-in ones, which makes the node a ReAct loop
   * over them. They are served as the in-process MCP server named after the node.
   */
  tools?: SdkMcpToolDefinition<any>[];
  /** Agent SDK options: cwd, allowedTools, permissionMode, maxBudgetUsd, maxTurns, ... */
  options?: Options;
  /**
   * How many times to send the validation errors back, in the same session, when the output
   * fails the schema. The JSON Schema the agent is held to cannot express zod refinements,
   * so an output can satisfy it and still fail here. Defaults to 0.
   */
  repairs?: number;
  /**
   * Problems with an output that passed validation, such as a quote the source does not
   * contain. They go back to the agent like validation errors, within the same `repairs`;
   * once those run out the output is returned as it is, so the caller can report them.
   */
  review?: (output: O, input: I) => string[];
}

export type Query = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export const defaultOptions: Options = {
  model: "claude-opus-5-5",
  // AGENTS.md / CLAUDE.md and the skills of the repository, not the user's settings.
  settingSources: ["project"],
};

/**
 * A node that runs Claude through the Agent SDK until it returns output. The tokens and the
 * estimated cost of the call are emitted as a usage event; a run that ends without valid
 * output throws.
 */
export function agentNode<I, O>(name: string, config: AgentConfig<I, O>, query: Query = sdkQuery): Node<I, O> {
  return {
    name,
    shape: { kind: "agent" },
    run: async (input, ctx) => {
      const options: Options = { ...defaultOptions, ...config.options };
      if (config.tools?.length) {
        options.mcpServers = { ...options.mcpServers, [name]: createSdkMcpServer({ name, tools: config.tools }) };
        options.allowedTools = [...(options.allowedTools ?? []), `mcp__${name}`];
      }
      // Claude Code rejects the draft 2020-12 $schema that zod writes; the schema is valid without it.
      // No tuples: the CLI rejects their prefixItems, and the API their draft-07 form.
      const { $schema: _, ...schema } = z.toJSONSchema(config.output) as Record<string, unknown>;
      options.outputFormat = { type: "json_schema", schema };

      let prompt = config.prompt(input);
      let resume: string | undefined;
      for (let attempt = 0; ; attempt++) {
        const message = await lastResult(query({ prompt, options: { ...options, resume } }));
        if (message === undefined) break;
        const models = tokensByModel(message);
        ctx.emit({ type: "usage", node: name, usd: message.total_cost_usd, models });
        if (message.subtype !== "success") {
          throw new Error(`${name}: ${message.subtype}: ${message.errors.join("; ")}`);
        }
        // An API error (a rejected schema, say) still ends as subtype "success", with no output.
        if (message.is_error) throw new Error(`${name}: ${message.result}`);
        const parsed = config.output.safeParse(message.structured_output);
        const problems = parsed.success
          ? (config.review?.(parsed.data, input) ?? [])
          : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        const issues = problems.map((p) => `- ${p}`).join("\n");
        if (attempt >= (config.repairs ?? 0) || problems.length === 0) {
          if (parsed.success) return parsed.data;
          throw new Error(`${name}: invalid output:\n${issues}`);
        }
        ctx.emit({ type: "retry", node: name, attempt: attempt + 1, error: issues });
        prompt = `Your output has these problems:\n${issues}\n\nReturn the whole output again with each of these fixed.`;
        resume = message.session_id;
      }
      throw new Error(`${name}: the agent ended without a result`);
    },
  };
}

type ResultMessage = Extract<SDKMessage, { type: "result" }>;

function tokensByModel(message: ResultMessage) {
  return Object.fromEntries(
    Object.entries(message.modelUsage ?? {}).map(([model, u]) => [
      model,
      {
        input: u.inputTokens,
        output: u.outputTokens,
        cacheRead: u.cacheReadInputTokens,
        cacheCreation: u.cacheCreationInputTokens,
      },
    ]),
  );
}

async function lastResult(messages: AsyncIterable<SDKMessage>): Promise<ResultMessage | undefined> {
  for await (const message of messages) {
    if (message.type === "result") return message;
  }
  return undefined;
}
