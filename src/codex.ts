import {
  Codex,
  type CodexOptions,
  type SandboxMode,
  type ThreadItem,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";

import {
  type Access,
  type Activity,
  type AgentRuntime,
  brief,
  defineRuntime,
  InterruptedError,
  OutputError,
} from "./runtime.ts";

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
      // What Thread.run does, with the items reported as they come.
      const turn: { finalResponse: string; usage: Usage | null } = { finalResponse: "", usage: null };
      try {
        const { events } = await t.runStreamed(request.prompt, {
          outputSchema: request.outputSchema,
          signal: request.signal,
        });
        for await (const event of events) {
          if (event.type === "turn.failed") throw new Error(event.error.message);
          if (event.type === "turn.completed") turn.usage = event.usage;
          if (event.type !== "item.started" && event.type !== "item.completed") continue;
          const isDone = event.type === "item.completed";
          if (isDone && event.item.type === "agent_message") turn.finalResponse = event.item.text;
          const activity = activityOf(event.item, isDone);
          if (activity) request.onActivity?.(activity);
        }
      } catch (error) {
        // The thread keeps the turns so far once it has started.
        if (request.signal?.aborted && t.id) throw new InterruptedError(t.id, request.signal.reason);
        throw error;
      }
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

/** Tools are reported when they start, and what is whole only at its end (a message, a patch, a search) then. */
function activityOf(item: ThreadItem, isDone: boolean): Activity | undefined {
  if (!isDone) {
    if (item.type === "command_execution") return { tool: "command", text: brief(item.command) };
    if (item.type === "mcp_tool_call") return { tool: `${item.server}/${item.tool}`, text: brief(item.arguments) };
    return undefined;
  }
  if (item.type === "agent_message") return item.text.trim() === "" ? undefined : { text: item.text };
  if (item.type === "file_change") {
    return {
      tool: "file_change",
      text: brief(item.changes.map((change) => `${change.kind} ${change.path}`).join(", ")),
    };
  }
  if (item.type === "web_search") return { tool: "web_search", text: brief(item.query) };
  return undefined;
}
