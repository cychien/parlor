import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import { buildServer } from "./build.js";
import { hostEntrySource } from "./entry.js";

describe("hostEntrySource", () => {
  it("serves the SPA document outside the framework prefix and delegates the rest", () => {
    const source = hostEntrySource({
      serverEntry: "/app/server.ts",
      basePath: "/_parlor",
    });
    expect(source).toContain('import app from "/app/server.ts"');
    expect(source).toContain("__PARLOR_INDEX_HTML__");
    expect(source).toContain("app.fetch(request)");
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port assigned")),
      );
    });
  });
}

describe("buildServer", () => {
  it("builds a node-server bundle that serves the app, static assets, and the SPA fallback", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-host-"));
    await writeFile(
      join(rootDir, "server.ts"),
      [
        'const transport = (value = process.env.PARLOR_SYNC_TRANSPORT) => value ?? "unset";',
        "export default { fetch: (request: Request) => Response.json({ path: new URL(request.url).pathname, transport: transport() }) };",
      ].join("\n"),
    );
    await mkdir(join(rootDir, ".parlor", "web", "assets"), { recursive: true });
    await writeFile(
      join(rootDir, ".parlor", "web", "index.html"),
      "<!doctype html><title>spa</title>",
    );
    await writeFile(join(rootDir, ".parlor", "web", "assets", "a.js"), "console.log(1)");
    const config = parseConfig({ app: { id: "dev.parlor.host", name: "Host" } });

    const result = await buildServer(
      { config, rootDir, configFile: "parlor.config.ts" },
      { preset: "node-server" },
    );
    expect(result.syncTransport).toBe("sse");
    const bundle = await readFile(join(result.outputDir, "server", "index.mjs"), "utf8");
    expect(bundle).not.toContain("PARLOR_SYNC_TRANSPORT");

    const port = await freePort();
    const child = spawn(
      process.execPath,
      [join(result.outputDir, "server", "index.mjs")],
      {
        env: { ...process.env, PORT: String(port) },
        stdio: "ignore",
      },
    );
    try {
      const ready = async () => {
        for (let i = 0; i < 50; i++) {
          try {
            return await fetch(`http://localhost:${port}/_parlor/ping`);
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        throw new Error("server did not start");
      };
      const api = await ready();
      await expect(api.json()).resolves.toEqual({
        path: "/_parlor/ping",
        transport: "sse",
      });
      const asset = await fetch(`http://localhost:${port}/assets/a.js`);
      await expect(asset.text()).resolves.toBe("console.log(1)");
      const page = await fetch(`http://localhost:${port}/tasks/42`, {
        headers: { accept: "text/html" },
      });
      expect(page.headers.get("content-type")).toContain("text/html");
      await expect(page.text()).resolves.toContain("<title>spa</title>");
    } finally {
      child.kill();
    }
  }, 120_000);
});
