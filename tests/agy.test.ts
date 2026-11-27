import { describe, expect, it } from "vite-plus/test";

import { agyCommand, agyRuntime } from "../src/agy.ts";

describe("agy", () => {
  it("starts agy acp by default", () => {
    expect(agyCommand()).toEqual({ command: "agy", args: ["acp"], env: undefined, mcpServers: undefined });
  });

  it("turns the options into flags", () => {
    const command = agyCommand({
      command: "/opt/agy",
      addDirs: ["../lib", "../docs"],
      agent: "coder",
      sandbox: true,
      processPerSession: true,
      logFile: "acp.log",
      disableTelemetry: true,
      env: { GEMINI_API_KEY: "key" },
      args: ["--extra"],
    });
    expect(command.command).toBe("/opt/agy");
    expect(command.args).toEqual([
      "acp",
      "--add-dir",
      "../lib",
      "--add-dir",
      "../docs",
      "--agent",
      "coder",
      "--sandbox",
      "--process-per-session",
      "--log-file",
      "acp.log",
      "--disable-telemetry",
      "--extra",
    ]);
    expect(command.env).toEqual({ GEMINI_API_KEY: "key" });
  });

  it("is named agy", async () => {
    const runtime = agyRuntime();
    expect(runtime.name).toBe("agy");
    await runtime.close();
  });
});
