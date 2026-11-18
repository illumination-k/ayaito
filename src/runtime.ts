import type { Tokens } from "./node.ts";

/**
 * How far an agent may touch its working directory: read only, or also edit and run
 * commands. Workflows run unattended, so a call never waits for approval; whatever the
 * level does not cover is refused.
 */
export type Access = "read-only" | "write";

/**
 * A schema that validates (Standard Schema) and converts to JSON Schema (Standard JSON
 * Schema), such as one of zod 4.2+. Codex needs every object strict (z.strictObject), as
 * OpenAI structured outputs reject open ones. Do not use tuples: the Claude CLI validates
 * with draft-07 and the API with 2020-12, and one of them rejects them.
 */
export interface OutputSchema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: unknown; readonly output: T } | undefined;
    readonly validate: (value: unknown) => ValidationResult<T> | Promise<ValidationResult<T>>;
    readonly jsonSchema: { readonly output: (options: { readonly target: string }) => Record<string, unknown> };
  };
}

type ValidationResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
      }>;
    };

/**
 * A call to an agent, made only of what Claude, Codex, opencode and ACP agents all support. Settings of
 * a single runtime belong to its factory (claudeRuntime({ allowedTools }), ...), which keeps
 * a node free to move between runtimes.
 */
export interface AgentRequest<T = undefined> {
  prompt: string;
  /**
   * The node making the call, set by agentNode and refineNode. For a runtime that shows or
   * records its calls per node; the built-in ones do not use it.
   */
  node?: string;
  system?: string;
  /** In the runtime's own naming: `claude-opus-5-5`, or `anthropic/claude-opus-5-5` on opencode. */
  model?: string;
  /** Defaults to the runtime's own (the process's working directory). */
  cwd?: string;
  /** Overrides the tools and permissions the runtime was made with. */
  access?: Access;
  /** The shape of the answer. The parsed value is AgentResult.structured. */
  output?: OutputSchema<T>;
  /** Resumes an earlier call (its AgentResult.sessionId) with its history, instead of a new one. */
  sessionId?: string;
  signal?: AbortSignal;
}

/** What a call cost, as far as the runtime reports it. */
export interface Usage {
  /** Absent when the runtime reports tokens only (codex, or an ACP agent that sends no cost). */
  costUsd?: number;
  models?: Record<string, Tokens>;
}

export interface AgentResult<T = undefined> extends Usage {
  text: string;
  structured: T;
  sessionId: string;
}

export interface AgentRuntime {
  readonly name: string;
  run<T = undefined>(request: AgentRequest<T>): Promise<AgentResult<T>>;
  close(): Promise<void>;
}

/**
 * The answer failed AgentRequest.output. It keeps the session, so that refine can ask the
 * same agent to fix it, and the usage, so that the call is still counted.
 */
export class OutputError extends Error {
  override name = "OutputError";
  readonly sessionId: string;
  readonly issues: string;
  readonly usage: Usage;

  constructor(sessionId: string, issues: string, usage: Usage = {}) {
    super(`Your final answer does not match the output schema:\n${issues}\n\nAnswer again with these fixed.`);
    this.sessionId = sessionId;
    this.issues = issues;
    this.usage = usage;
  }
}

/** The request and result of an adapter: JSON Schema in, an unchecked answer out. */
export type RawRequest = Omit<AgentRequest, "output"> & { outputSchema?: Record<string, unknown> };
export type RawResult = Omit<AgentResult, "structured"> & { structured?: unknown };

/** Turns an adapter into a runtime; the schema conversion and the validation happen here, once for all. */
export function defineRuntime(adapter: {
  name: string;
  run(request: RawRequest): Promise<RawResult>;
  close?(): Promise<void>;
}): AgentRuntime {
  return {
    name: adapter.name,
    async run<T>({ output, ...request }: AgentRequest<T>): Promise<AgentResult<T>> {
      const raw = await adapter.run({ ...request, outputSchema: output && jsonSchema(output) });
      if (!output) return { ...raw, structured: undefined as T };
      const parsed = await output["~standard"].validate(raw.structured);
      if (parsed.issues) {
        const { costUsd, models } = raw;
        throw new OutputError(raw.sessionId, describe(parsed.issues), { costUsd, models });
      }
      return { ...raw, structured: parsed.value };
    },
    close: () => adapter.close?.() ?? Promise.resolve(),
  };
}

/** Claude Code rejects the $schema that 2020-12 output carries; the schema is valid without it. */
function jsonSchema(output: OutputSchema<unknown>): Record<string, unknown> {
  const { $schema: _, ...schema } = output["~standard"].jsonSchema.output({ target: "draft-2020-12" });
  return schema;
}

function describe(issues: Extract<ValidationResult<unknown>, { issues: unknown }>["issues"]): string {
  return issues
    .map((i) => {
      const path = i.path?.map((p) => String(typeof p === "object" ? p.key : p)).join(".");
      return `- ${path || "(root)"}: ${i.message}`;
    })
    .join("\n");
}
