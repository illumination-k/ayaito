import type { McpServer } from "@agentclientprotocol/sdk/unstable";

import { acpRuntime, type AcpRuntimeOptions, type Connect } from "./acp.ts";
import type { AgentRuntime } from "./runtime.ts";

export interface AgyRuntimeOptions {
  /** The agy binary, `agy` on PATH by default. */
  command?: string;
  /** Workspace directories besides the cwd (`--add-dir`). */
  addDirs?: string[];
  /** The agent its sessions use, one of `agy agents` (`--agent`). */
  agent?: string;
  /** Runs terminal commands in the sandbox (`--sandbox`). */
  sandbox?: boolean;
  /** Each session in a worker process of its own (`--process-per-session`), which HTTP MCP servers need. */
  processPerSession?: boolean;
  /** Where the ACP server writes its log (`--log-file`). */
  logFile?: string;
  disableTelemetry?: boolean;
  /** Added to the environment of agy, e.g. `GEMINI_API_KEY`. */
  env?: Record<string, string>;
  /** MCP servers every session gets. */
  mcpServers?: McpServer[];
  /** More arguments after `acp`. */
  args?: string[];
}

/** The command that starts `agy acp` with these options. */
export function agyCommand(options: AgyRuntimeOptions = {}): AcpRuntimeOptions {
  const args = ["acp"];
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
  if (options.agent !== undefined) args.push("--agent", options.agent);
  if (options.sandbox) args.push("--sandbox");
  if (options.processPerSession) args.push("--process-per-session");
  if (options.logFile !== undefined) args.push("--log-file", options.logFile);
  if (options.disableTelemetry) args.push("--disable-telemetry");
  args.push(...(options.args ?? []));
  return { command: options.command ?? "agy", args, env: options.env, mcpServers: options.mcpServers };
}

/**
 * Runs calls on the Antigravity CLI through its ACP server (`agy acp`), so it works as
 * `acpRuntime` does: `access` answers agy's permission requests, the schema goes into the
 * prompt and `model` sets the session's model option. Sign in first with `agy` or
 * `agy acp --login`, or pass `GEMINI_API_KEY` in `env`. `--dangerously-skip-permissions` would
 * let agents do what `access` refuses, so it is not an option here.
 */
export function agyRuntime(options: AgyRuntimeOptions = {}, connect?: Connect): AgentRuntime {
  return { ...acpRuntime(agyCommand(options), connect), name: "agy" };
}
