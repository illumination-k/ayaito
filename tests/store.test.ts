import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { FsStore } from "../src/index.ts";

const tmpStore = async () => new FsStore(await mkdtemp(join(tmpdir(), "ayaito-")));

describe("FsStore", () => {
  it("keeps outputs and events per run, and has nothing for a run it has not seen", async () => {
    const store = await tmpStore();
    expect(await store.get("r", "a")).toBeUndefined();
    expect(await store.events("r")).toEqual([]);
    await store.put("r", "a", { n: 1 });
    await store.append("r", { type: "start", node: "a", at: "t" });
    expect(await store.get("r", "a")).toEqual({ n: 1 });
    expect(await store.events("r")).toEqual([{ type: "start", node: "a", at: "t" }]);
    expect(await store.get("other", "a")).toBeUndefined();
  });

  it("invalidates only the outputs whose key starts with the prefix", async () => {
    const store = await tmpStore();
    expect(await store.invalidate("r", "fix")).toBe(0);
    await store.put("r", "fix.1", 1);
    await store.put("r", "fix.2", 2);
    await store.put("r", "plan", 3);
    await store.append("r", { type: "start", node: "fix", at: "t" });
    expect(await store.invalidate("r", "fix")).toBe(2);
    expect((await readdir(join(store.dir, "r"))).toSorted()).toEqual(["events.jsonl", "plan.json"]);
  });

  it("rejects a run id or key that would leave its directory", async () => {
    const store = await tmpStore();
    await expect(store.get("../r", "a")).rejects.toThrow("invalid run or key: ../r/a.json");
    await expect(store.put("r", "../a", 1)).rejects.toThrow("invalid run or key");
  });
});
