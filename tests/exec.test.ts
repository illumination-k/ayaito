import { describe, expect, it } from "vite-plus/test";

import { exec } from "../src/index.ts";

describe("exec", () => {
  it("returns a non-zero exit as the result, and throws when the command cannot start", async () => {
    expect(await exec("node", ["-e", "console.log('hi'); process.exit(3)"])).toEqual({
      code: 3,
      stdout: "hi\n",
      stderr: "",
    });
    await expect(exec("ayaito-no-such-command", [])).rejects.toThrow();
  });
});
