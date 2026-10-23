import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { putHostCommandFirstOnPath } from "./daemon.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

async function entry(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "host-entry-"));
  const file = join(dir, name);
  await writeFile(file, "process.stdout.write(process.argv.slice(2).join(' '));\n");
  return file;
}

describe("parlor-host on the agents' PATH", () => {
  it("runs a published entry named main.js through a shim with node", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-root-"));
    await putHostCommandFirstOnPath(root, await entry("main.js"));
    const command = join(root, "bin", "parlor-host");
    expect(execFileSync(command, ["mcp-proxy", "it's"], { encoding: "utf8" })).toBe(
      "mcp-proxy it's",
    );
    expect(process.env.PATH?.split(delimiter)[0]).toBe(join(root, "bin"));
  });

  it("links an entry already named parlor-host", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-root-"));
    const file = await entry("parlor-host-dev.mjs");
    await putHostCommandFirstOnPath(root, file);
    const command = join(root, "bin", "parlor-host");
    expect((await lstat(command)).isSymbolicLink()).toBe(true);
    expect(await readlink(command)).toBe(await realpath(file));
  });
});
