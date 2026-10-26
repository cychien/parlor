import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentInfo } from "@parlor/chat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { learnedStore } from "./learned.js";

const CLAUDE: AgentInfo = { id: "claude", name: "Claude Code", ready: true };
const OPTIONS = [
  {
    id: "model",
    name: "Model",
    current: "default",
    values: [{ id: "default", name: "Default" }],
  },
];

describe("what agents said about themselves", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "parlor-learned-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("adds it to the agents it reports, and keeps it across restarts", async () => {
    const file = join(dir, "learned.json");
    const store = learnedStore(file);
    await store.load();
    expect(store.describe([CLAUDE], 0)).toEqual([CLAUDE]);
    expect(store.knows("claude")).toBe(false);
    expect(await store.learn("claude", { options: OPTIONS })).toBe(true);
    expect(store.knows("claude")).toBe(true);
    expect(await store.learn("claude", { options: OPTIONS })).toBe(false);
    expect(
      await store.learn("claude", {
        usage: {
          windows: [{ id: "five_hour", minutes: 300, used: 0.5, resetsAt: 2_000 }],
          at: 1,
        },
      }),
    ).toBe(true);

    const restarted = learnedStore(file);
    await restarted.load();
    expect(restarted.describe([CLAUDE], 1_000)).toEqual([
      {
        ...CLAUDE,
        options: OPTIONS,
        usage: {
          windows: [{ id: "five_hour", minutes: 300, used: 0.5, resetsAt: 2_000 }],
          at: 1,
        },
      },
    ]);
    expect(restarted.describe([CLAUDE], 3_000)).toEqual([
      { ...CLAUDE, options: OPTIONS },
    ]);
  });

  it("starts empty from a file that is not JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    const file = join(dir, "broken.json");
    await writeFile(file, "{not json");
    const store = learnedStore(file);
    await store.load();
    expect(store.describe([CLAUDE], 0)).toEqual([CLAUDE]);
  });
});
