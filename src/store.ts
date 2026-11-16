import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunEvent, Store } from "./node.ts";

/** Keeps each run in <dir>/<runId>/: one JSON file per output and events.jsonl. */
export class FsStore implements Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async get(runId: string, key: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path(runId, `${key}.json`), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(runId: string, key: string, value: unknown): Promise<void> {
    await mkdir(join(this.dir, runId), { recursive: true });
    await writeFile(this.path(runId, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }

  async invalidate(runId: string, prefix: string): Promise<number> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, runId));
    } catch {
      return 0;
    }
    const hits = names.filter((n) => n.startsWith(prefix) && n.endsWith(".json"));
    await Promise.all(hits.map((n) => rm(this.path(runId, n))));
    return hits.length;
  }

  async append(runId: string, event: RunEvent): Promise<void> {
    await mkdir(join(this.dir, runId), { recursive: true });
    await appendFile(this.path(runId, "events.jsonl"), `${JSON.stringify(event)}\n`);
  }

  async events(runId: string): Promise<RunEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path(runId, "events.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);
  }

  private path(runId: string, name: string): string {
    if (runId.includes("/") || name.includes("/")) throw new Error(`invalid run or key: ${runId}/${name}`);
    return join(this.dir, runId, name);
  }
}
