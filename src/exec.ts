import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command and waits for it. The exit code is part of the result, since a failing
 * test or lint is an answer, not a crash; only a command that cannot start (or is
 * aborted) rejects.
 */
export function exec(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}
