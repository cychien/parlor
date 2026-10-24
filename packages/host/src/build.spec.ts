import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
      contentSecurityPolicy: "default-src 'self'",
    });
    expect(source).toContain('import app from "/app/server.ts"');
    expect(source).toContain("__PARLOR_INDEX_HTML__");
    expect(source).toContain("__PARLOR_PAGE_ROUTES__");
    expect(source).toContain(`"content-security-policy": "default-src 'self'"`);
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
        "  fetch: (request: Request) => {",
        "    const path = new URL(request.url).pathname;",
        '    if (!path.startsWith("/_parlor/")) return new Response(null, { status: 404, headers: { "x-parlor-unrouted": "1" } });',
        "    return Response.json({ path, transport: transport(), ui: ui?.() ?? null });",
        "  },",
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
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

describe("buildServer content security policy", () => {
  it("sends the policy on pages, assets and the SPA fallback but leaves the app's own responses to themselves", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-host-csp-"));
    await writeFile(
      join(rootDir, "server.ts"),
      [
        "export default {",
        "  fetch: (request: Request) => {",
        "    const path = new URL(request.url).pathname;",
        '    if (path === "/_parlor/own") return new Response(path, { headers: { "content-security-policy": "default-src none" } });',
        '    if (path === "/api/hook") return new Response(path);',
        '    return new Response(null, { status: 404, headers: { "x-parlor-unrouted": "1" } });',
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
      expect(
        await policyOf("/api/hook", { headers: { accept: "text/html" } }),
      ).toBeNull();
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

const require = createRequire(import.meta.url);

function wranglerBin(): string {
  const manifest = require.resolve("wrangler/package.json");
  const { bin } = require(manifest) as { bin: { wrangler: string } };
  return join(dirname(manifest), bin.wrangler);
}

describe("buildServer for cloudflare-durable", () => {
  it("serves page documents from the Worker and runs the app in one Durable Object", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-host-cf-"));
    await writeFile(
      join(rootDir, "server.ts"),
      [
        "await Promise.resolve();",
        "let served = 0;",
        "let ui: (() => unknown) | undefined;",
        "declare const __PARLOR_MIGRATIONS__: Record<string, unknown[]> | undefined;",
        "const migrations = typeof __PARLOR_MIGRATIONS__ === 'undefined' ? null : Object.fromEntries(Object.entries(__PARLOR_MIGRATIONS__).map(([folder, list]) => [folder, list.length]));",
        "export default {",
        "  installUiManifest: (source: () => unknown) => { ui = source; },",
        "  fetch: (request: Request) => {",
        "    const path = new URL(request.url).pathname;",
        "    served += 1;",
        '    if (path.startsWith("/_parlor/") || path === "/webhooks/pay") return Response.json({ path, served, ui: ui?.() ?? null, migrations, transport: process.env.PARLOR_SYNC_TRANSPORT ?? null });',
        '    return new Response(null, { status: 404, headers: { "x-parlor-unrouted": "1" } });',
        "  },",
        "};",
      ].join("\n"),
    );
    await mkdir(join(rootDir, "migrations", "meta"), { recursive: true });
    await writeFile(
      join(rootDir, "migrations", "0000_init.sql"),
      "create table t (n int);",
    );
    await writeFile(
      join(rootDir, "migrations", "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_init", breakpoints: true }],
      }),
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
    const config = parseConfig({ app: { id: "dev.parlor.hostcf", name: "Host" } });

    const result = await buildServer(
      { config, rootDir, configFile: "parlor.config.ts" },
      { preset: "cloudflare-durable" },
    );
    expect(result.syncTransport).toBe("sse");
    const wrangler = JSON.parse(
      await readFile(join(result.outputDir, "server", "wrangler.json"), "utf8"),
    );
    expect(wrangler.name).toBe("dev-parlor-hostcf");
    expect(wrangler.durable_objects.bindings).toEqual([
      { name: "PARLOR_SERVER", class_name: "ParlorServer" },
    ]);
    expect(wrangler.migrations).toEqual([
      { tag: "parlor-server-v1", new_sqlite_classes: ["ParlorServer"] },
    ]);

    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        wranglerBin(),
        "dev",
        "--config",
        join(result.outputDir, "server", "wrangler.json"),
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
      ],
      {
        env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
        stdio: "ignore",
      },
    );
    try {
      const api = async (path: string) => {
        for (let i = 0; i < 200; i++) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}${path}`);
            if (response.ok) return (await response.json()) as Record<string, unknown>;
          } catch {}
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("wrangler dev did not start");
      };
      await expect(api("/_parlor/ping")).resolves.toEqual({
        path: "/_parlor/ping",
        served: 1,
        ui: { protocol: 1, routes: [{ path: "/settings" }] },
        migrations: { migrations: 1 },
        transport: "sse",
      });
      const objects = await fetch(
        `http://127.0.0.1:${port}/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces/dev-parlor-hostcf-ParlorServer/objects`,
      );
      await expect(objects.json()).resolves.toMatchObject({ result: [{ name: "app" }] });
      await expect(api("/webhooks/pay")).resolves.toMatchObject({ served: 2 });
      const asset = await fetch(`http://127.0.0.1:${port}/assets/a.js`);
      await expect(asset.text()).resolves.toBe("console.log(1)");
      const document = (path: string) =>
        fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: "text/html" } });
      const page = await document("/settings");
      expect(page.headers.get("content-type")).toContain("text/html");
      await expect(page.text()).resolves.toContain("<title>spa</title>");
      await expect(api("/_parlor/ping")).resolves.toMatchObject({ served: 3 });
      const unknown = await document("/tasks/42");
      expect(unknown.status).toBe(200);
      await expect(unknown.text()).resolves.toContain("<title>spa</title>");
      await expect(api("/_parlor/ping")).resolves.toMatchObject({ served: 5 });
    } finally {
      child.kill();
    }
  }, 180_000);
});

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const PAYMENTS_SERVER = [
  'import { createRegistry } from "@parlor/core/registry";',
  'import { createServer } from "@parlor/server";',
  "const routes = [",
  '  { method: "GET", path: "/api/payment/creem/return", absolute: true, access: "public", handle: async (request: Request) => new Response(null, { status: 303, headers: { location: `/payment/${new URL(request.url).searchParams.get("orderId")}` } }) },',
  '  { method: "GET", path: "/api/payment/payuni/checkout", absolute: true, access: "public", handle: async () => new Response("<form></form><script>document.forms[0].submit()</script>", { headers: { "content-type": "text/html; charset=utf-8" } }) },',
  '  { method: "POST", path: "/api/payment/webhook", absolute: true, access: "public", handle: async (request: Request) => Response.json({ received: await request.text() }) },',
  "] as const;",
  'export default createServer({ actions: createRegistry({}), plugins: [{ name: "payments", setup: () => ({ routes }) }] });',
].join("\n");

function startBuilt(
  preset: "node-server" | "cloudflare-durable",
  outputDir: string,
  port: number,
) {
  return preset === "node-server"
    ? spawn(process.execPath, [join(outputDir, "server", "index.mjs")], {
        env: productionEnv(port),
        stdio: "ignore",
      })
    : spawn(
        process.execPath,
        [
          wranglerBin(),
          "dev",
          "--config",
          join(outputDir, "server", "wrangler.json"),
          "--port",
          String(port),
          "--ip",
          "127.0.0.1",
        ],
        {
          env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
          stdio: "ignore",
        },
      );
}

describe("absolute plugin routes in a built app", () => {
  it.each(["node-server", "cloudflare-durable"] as const)(
    "reach a browser's document request on %s, while pages and unknown paths get the SPA",
    async (preset) => {
      await mkdir(GENERATED_DIR, { recursive: true });
      const rootDir = await mkdtemp(join(GENERATED_DIR, "absolute-"));
      await writeFile(join(rootDir, "server.ts"), PAYMENTS_SERVER);
      await mkdir(join(rootDir, ".parlor", "web"), { recursive: true });
      await writeFile(
        join(rootDir, ".parlor", "web", "index.html"),
        "<!doctype html><title>spa</title>",
      );
      await writeFile(
        join(rootDir, ".parlor", "ui-manifest.json"),
        JSON.stringify({
          protocol: 1,
          app: { id: "dev.parlor.pay", name: "Pay" },
          routes: ["/", "/payment/$orderId", "/settings"].map((path) => ({
            path,
            params: [],
            views: [],
          })),
          views: [],
        }),
      );
      const config = parseConfig({ app: { id: "dev.parlor.pay", name: "Pay" } });
      const result = await buildServer(
        { config, rootDir, configFile: "parlor.config.ts" },
        { preset },
      );
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const child = startBuilt(preset, result.outputDir, port);
      try {
        for (let i = 0; ; i++) {
          const response = await fetch(`${origin}/_parlor/manifest`).catch(
            () => undefined,
          );
          if (response?.ok) break;
          if (i === 300) throw new Error(`${preset} did not start`);
          await new Promise((r) => setTimeout(r, 100));
        }
        const browse = (path: string) =>
          fetch(`${origin}${path}`, {
            headers: { accept: BROWSER_ACCEPT },
            redirect: "manual",
          });

        const back = await browse("/api/payment/creem/return?orderId=o1");
        expect(back.status).toBe(303);
        expect(back.headers.get("location")).toBe("/payment/o1");

        const checkout = await browse("/api/payment/payuni/checkout?orderId=o1");
        await expect(checkout.text()).resolves.toContain("document.forms[0].submit()");
        expect(checkout.headers.get("content-security-policy")).toBeNull();

        const hook = await fetch(`${origin}/api/payment/webhook`, {
          method: "POST",
          body: "paid",
        });
        await expect(hook.json()).resolves.toEqual({ received: "paid" });

        const page = await browse("/payment/o1");
        await expect(page.text()).resolves.toContain("<title>spa</title>");
        expect(page.headers.get("content-security-policy")).toBe(DEFAULT_POLICY);

        const missing = await browse("/no/such/page");
        expect(missing.status).toBe(200);
        await expect(missing.text()).resolves.toContain("<title>spa</title>");
        expect(missing.headers.get("content-security-policy")).toBe(DEFAULT_POLICY);

        const missingData = await fetch(`${origin}/no/such/page`);
        expect(missingData.status).toBe(404);
        await expect(missingData.json()).resolves.toMatchObject({
          error: { code: "not_found" },
        });
      } finally {
        child.kill();
        await rm(rootDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
