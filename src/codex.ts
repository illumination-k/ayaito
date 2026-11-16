import { Codex, type CodexOptions, type SandboxMode, type ThreadOptions } from "@openai/codex-sdk";

import { type Access, type AgentRuntime, defineRuntime, OutputError } from "./runtime.ts";

export type CodexRuntimeOptions = CodexOptions & {
  thread?: Omit<ThreadOptions, "approvalPolicy" | "model" | "sandboxMode" | "workingDirectory">;
};

// Codex's workspace-write sandbox does not start inside an unprivileged container, so write
// lifts the sandbox; isolate such calls yourself, as you would Bash on the other runtimes.
const SANDBOX: Record<Access, SandboxMode> = { "read-only": "read-only", write: "danger-full-access" };

/**
 * Runs calls through the Codex SDK, with approvals off. A call without access gets the
 * read-only sandbox. Usage has token counts only.
 */
export function codexRuntime({ thread, ...base }: CodexRuntimeOptions = {}): AgentRuntime {
  return defineRuntime({
    name: "codex",
    async run(request) {
      // The system prompt goes in as developer_instructions, the closest config codex has.
      const codex = new Codex(
        request.system ? { ...base, config: { ...base.config, developer_instructions: request.system } } : base,
      );
      const options: ThreadOptions = {
        skipGitRepoCheck: true,
        ...thread,
        approvalPolicy: "never",
        model: request.model,
        sandboxMode: SANDBOX[request.access ?? "read-only"],
        workingDirectory: request.cwd,
      };
      const t = request.sessionId ? codex.resumeThread(request.sessionId, options) : codex.startThread(options);
      const turn = await t.run(request.prompt, { outputSchema: request.outputSchema, signal: request.signal });
      const sessionId = t.id;
      if (!sessionId) throw new Error("codex: no thread id after the turn");
      const usage = turn.usage;
      const models = usage
        ? {
            [request.model ?? "codex"]: {
              input: usage.input_tokens - usage.cached_input_tokens,
              output: usage.output_tokens,
              cacheRead: usage.cached_input_tokens,
              cacheCreation: usage.cache_write_input_tokens,
            },
          }
        : undefined;
      let structured: unknown;
      if (request.outputSchema) {
        try {
          structured = JSON.parse(turn.finalResponse);
        } catch {
          throw new OutputError(sessionId, "- (root): the answer could not be parsed as JSON", { models });
        }
      }
      return { text: turn.finalResponse, structured, sessionId, models };
    },
  });
}
