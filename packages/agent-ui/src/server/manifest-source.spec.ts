import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fileManifestSource } from "./manifest-source.js";

const manifest = (name: string) => ({
  protocol: 1,
  app: { id: "dev.parlor.test", name },
  routes: [],
  views: [],
});

describe("fileManifestSource", () => {
  it("reads the file when it appears, keeps the parsed object until mtime changes, and forgets it when removed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parlor-manifest-"));
    const file = join(dir, "ui-manifest.json");
    const source = fileManifestSource(file);
    expect(source()).toBeUndefined();

    await writeFile(file, JSON.stringify(manifest("One")));
    const first = source();
    expect(first).toEqual(manifest("One"));
    expect(source()).toBe(first);

    await writeFile(file, JSON.stringify(manifest("Two")));
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    expect(source()).toEqual(manifest("Two"));

    await writeFile(file, "{ half written");
    await utimes(file, new Date(), new Date(Date.now() + 10_000));
    expect(source()).toEqual(manifest("Two"));

    await rm(file);
    expect(source()).toBeUndefined();
  });

  it("reads a manifest written before views were writable as read-only views", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parlor-manifest-"));
    const file = join(dir, "ui-manifest.json");
    const old = {
      ...manifest("Old"),
      views: [{ name: "task", description: "A task.", keyed: true }],
    };
    await writeFile(file, JSON.stringify(old));
    expect(fileManifestSource(file)()?.views).toEqual([
      { name: "task", description: "A task.", keyed: true, writable: [] },
    ]);
    await rm(dir, { recursive: true });
  });
});
