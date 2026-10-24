import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    expect(source).toContain("app.installUiManifest?.(() => UI_MANIFEST)");
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
        "let ui: (() => unknown) | undefined;",
        "export default {",
        "  installUiManifest: (source: () => unknown) => { ui = source; },",
        "  fetch: (request: Request) => Response.json({ path: new URL(request.url).pathname, transport: transport(), ui: ui?.() ?? null }),",
        "};",
      ].join("\n"),
    );
    await mkdir(join(rootDir, ".parlor", "web", "assets"), { recursive: true });
    await writeFile(
      join(rootDir, ".parlor", "web", "index.html"),
      "<!doctype html><title>spa</title>",
    );
    await writeFile(join(rootDir, ".parlor", "web", "assets", "a.js"), "console.log(1)");
    await writeFile(
      join(rootDir, ".parlor", "ui-manifest.json"),
      JSON.stringify({ protocol: 1, routes: [{ path: "/settings" }] }),
    );
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
        ui: { protocol: 1, routes: [{ path: "/settings" }] },
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

describe("buildServer app name", () => {
  it("bakes config.app.name into the bundle as PARLOR_APP_NAME", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-host-name-"));
    await writeFile(
      join(rootDir, "server.ts"),
      [
        "export default {",
        "  fetch: () => Response.json({ appName: process.env.PARLOR_APP_NAME ?? null }),",
        "};",
      ].join("\n"),
    );
    const config = parseConfig({ app: { id: "dev.parlor.host", name: "Host App" } });
    const result = await buildServer(
      { config, rootDir, configFile: "parlor.config.ts" },
      { preset: "node-server" },
    );

    const port = await freePort();
    const { PARLOR_APP_NAME: _name, ...env } = process.env;
    const child = spawn(
      process.execPath,
      [join(result.outputDir, "server", "index.mjs")],
      {
        env: { ...env, PORT: String(port) },
        stdio: "ignore",
      },
    );
    try {
      for (let i = 0; i < 50; i++) {
        try {
          const response = await fetch(`http://localhost:${port}/_parlor/name`);
          await expect(response.json()).resolves.toEqual({ appName: "Host App" });
          return;
        } catch (error) {
          if (error instanceof Error && error.name === "AssertionError") throw error;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      throw new Error("server did not start");
    } finally {
      child.kill();
    }
  }, 120_000);
});

const DEFAULT_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

describe("buildServer content security policy", () => {
  it("sends the policy on pages, assets and the SPA fallback but leaves framework routes to themselves", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-host-csp-"));
    await writeFile(
      join(rootDir, "server.ts"),
      [
        "export default {",
        "  fetch: (request: Request) => {",
        "    const path = new URL(request.url).pathname;",
        '    const headers = path === "/_parlor/own" ? { "content-security-policy": "default-src none" } : undefined;',
        "    return new Response(path, { headers });",
        "  },",
        "};",
      ].join("\n"),
    );
    await mkdir(join(rootDir, ".parlor", "web"), { recursive: true });
    await writeFile(
      join(rootDir, ".parlor", "web", "index.html"),
      "<!doctype html><title>spa</title>",
    );
    const config = parseConfig({
      app: { id: "dev.parlor.host", name: "Host" },
      web: { csp: { "connect-src": ["https://relay.example.com"] } },
    });
    const result = await buildServer(
      { config, rootDir, configFile: "parlor.config.ts" },
      { preset: "node-server" },
    );

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
      const policyOf = async (path: string, init?: RequestInit) => {
        for (let i = 0; i < 50; i++) {
          try {
            const response = await fetch(`http://localhost:${port}${path}`, init);
            return response.headers.get("content-security-policy");
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        throw new Error("server did not start");
      };
      const expected = DEFAULT_POLICY.replace(
        "connect-src 'self'",
        "connect-src 'self' https://relay.example.com",
      );
      expect(await policyOf("/", { headers: { accept: "text/html" } })).toBe(expected);
      expect(await policyOf("/tasks/42", { headers: { accept: "text/html" } })).toBe(
        expected,
      );
      expect(await policyOf("/index.html")).toBe(expected);
      expect(await policyOf("/_parlor/own")).toBe("default-src none");
    } finally {
      child.kill();
    }
  }, 120_000);
});

const SHUTDOWN_BOUND_MS = 2000;
const GENERATED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".parlor");

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function productionEnv(port: number): NodeJS.ProcessEnv {
  const { CI: _ci, TEST: _test, ...env } = process.env;
  return { ...env, PORT: String(port) };
}

describe("built node-server shutdown", () => {
  it.each([
    ["without a client", false],
    ["with an open sync stream", true],
  ])(
    "exits cleanly and promptly on SIGTERM %s",
    async (_name, withStream) => {
      await mkdir(GENERATED_DIR, { recursive: true });
      const rootDir = await mkdtemp(join(GENERATED_DIR, "shutdown-"));
      await writeFile(
        join(rootDir, "server.ts"),
        [
          'import { createRegistry } from "@parlor/core/registry";',
          'import { createDatabase } from "@parlor/data";',
          'import { createServer } from "@parlor/server";',
          `const database = await createDatabase({ dataDir: ${JSON.stringify(join(rootDir, "pglite"))} });`,
          "export default createServer({ actions: createRegistry({}), database });",
        ].join("\n"),
      );
      const config = parseConfig({ app: { id: "dev.parlor.host", name: "Host" } });
      const result = await buildServer(
        { config, rootDir, configFile: "parlor.config.ts" },
        { preset: "node-server" },
      );

      const port = await freePort();
      const child = spawn(
        process.execPath,
        [join(result.outputDir, "server", "index.mjs")],
        { env: productionEnv(port), stdio: "ignore" },
      );
      const exitCode = exited(child);
      const controller = new AbortController();
      try {
        const url = `http://localhost:${port}/_parlor/sync/stream`;
        let response: Response | undefined;
        for (let i = 0; i < 100 && !response; i++) {
          response = await fetch(url, {
            headers: { accept: "text/event-stream" },
            signal: controller.signal,
          }).catch(() => undefined);
          if (!response) await new Promise((r) => setTimeout(r, 100));
        }
        if (!response) throw new Error("server did not start");
        if (withStream) await response.body!.getReader().read();
        else controller.abort();

        const startedAt = Date.now();
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        await exitCode;
        clearTimeout(killTimer);

        expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_BOUND_MS);
        expect(child.signalCode).toBeNull();
      } finally {
        controller.abort();
        child.kill("SIGKILL");
        await rm(rootDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
