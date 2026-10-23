import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { INITIAL_COMMIT_MESSAGE, initialCommit } from "./git.js";

const identity = {
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@example.com",
};

describe("initialCommit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("makes one commit on main with every file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parlor-git-"));
    await writeFile(join(directory, "a.txt"), "a");
    for (const [name, value] of Object.entries(identity)) vi.stubEnv(name, value);
    expect(await initialCommit(directory)).toEqual({ kind: "committed" });
    const log = execFileSync("git", ["log", "--format=%s %D"], {
      cwd: directory,
      encoding: "utf8",
    });
    expect(log.trim()).toBe(`${INITIAL_COMMIT_MESSAGE} HEAD -> main`);
  });

  it("skips a folder inside another repository", async () => {
    const outer = await mkdtemp(join(tmpdir(), "parlor-git-outer-"));
    execFileSync("git", ["init", "-q"], { cwd: outer });
    const inner = join(outer, "my-app");
    await mkdir(inner);
    expect(await initialCommit(inner)).toEqual({
      kind: "skipped",
      reason: "inside-repository",
    });
  });
});
