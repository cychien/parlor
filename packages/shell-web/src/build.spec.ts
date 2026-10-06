import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import { buildWeb } from "./build.js";

describe("buildWeb", () => {
  it("emits a static site with a web manifest and service worker", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-web-"));
    await writeFile(
      join(rootDir, "index.html"),
      `<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script type="module" src="/main.ts"></script></body></html>`,
    );
    await writeFile(join(rootDir, "main.ts"), `document.title = "built";`);
    const config = parseConfig({ app: { id: "com.example.todo", name: "Todo" } });

    const outDir = await buildWeb({ config, rootDir, configFile: "parlor.config.ts" });

    const files = await readdir(outDir);
    expect(outDir).toBe(join(rootDir, ".parlor", "web"));
    expect(files).toEqual(
      expect.arrayContaining(["index.html", "manifest.webmanifest", "sw.js"]),
    );
    const manifest = JSON.parse(
      await readFile(join(outDir, "manifest.webmanifest"), "utf8"),
    );
    expect(manifest).toMatchObject({
      id: "com.example.todo",
      name: "Todo",
      display: "standalone",
    });
  }, 30_000);
});
