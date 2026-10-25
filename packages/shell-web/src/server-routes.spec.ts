import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { build, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { parlorWeb } from "./plugin.js";

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const ROUTE_TREE = `export const routeTree = {
  isRoot: true,
  children: [
    { options: { path: "/settings", staticData: { description: "Settings." } } },
    { options: { path: "/payment/$orderId", staticData: { description: "An order." } } },
  ],
};
`;

async function app(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "parlor-server-routes-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><head><title>spa</title></head><body><script type="module" src="/main.ts"></script></body></html>',
  );
  await writeFile(join(root, "main.ts"), "export {};");
  await writeFile(join(root, "src", "routeTree.gen.ts"), ROUTE_TREE);
  return root;
}

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function appServer(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createHttpServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/api/payment/creem/return") {
        response.writeHead(303, { location: "/payment/o1" }).end();
      } else if (path === "/api/payment/webhook" && request.method === "POST") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ received: Buffer.concat(chunks).toString() }));
      } else {
        response
          .writeHead(404, {
            "content-type": "application/json",
            "x-parlor-unrouted": "1",
          })
          .end(JSON.stringify({ error: { code: "not_found" } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as AddressInfo).port, hits };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

describe("parlor dev", () => {
  it("sends what Vite does not serve to the app's server, and a page's document to Vite", async () => {
    const root = await app();
    const upstream = await appServer();
    const config = parseConfig({
      app: { id: "com.example.pay", name: "Pay" },
      server: { port: upstream.port },
      web: { port: await freePort(), pwa: false },
    });
    const vite = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: parlorWeb(config, { root }),
    });
    await vite.listen();
    closers.push(() => vite.close());
    const origin = `http://localhost:${config.web.port}`;
    await until(() =>
      access(join(root, ".parlor", "ui-manifest.json")).then(
        () => true,
        () => false,
      ),
    );
    const browse = (path: string) =>
      fetch(`${origin}${path}`, {
        headers: { accept: BROWSER_ACCEPT },
        redirect: "manual",
      });

    const back = await browse("/api/payment/creem/return?orderId=o1");
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/payment/o1");
    expect(back.headers.get("content-security-policy")).toBeNull();

    const hook = await fetch(`${origin}/api/payment/webhook`, {
      method: "POST",
      body: "paid",
    });
    await expect(hook.json()).resolves.toEqual({ received: "paid" });

    const page = await browse("/payment/o1");
    await expect(page.text()).resolves.toContain("<title>spa</title>");
    expect(page.headers.get("content-security-policy")).not.toBeNull();

    const missing = await browse("/no/such/page");
    expect(missing.status).toBe(200);
    await expect(missing.text()).resolves.toContain("<title>spa</title>");

    const module = await fetch(`${origin}/main.ts`);
    expect(module.status).toBe(200);

    const missingData = await fetch(`${origin}/no/such/page`);
    expect(missingData.status).toBe(404);

    expect(upstream.hits).toEqual([
      "GET /api/payment/creem/return?orderId=o1",
      "POST /api/payment/webhook",
      "GET /no/such/page",
      "GET /no/such/page",
    ]);
  });
});

describe("the service worker", () => {
  it("falls back to the app's document only for page routes", async () => {
    const root = await app();
    const outDir = join(root, "out");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: parlorWeb(parseConfig({ app: { id: "com.example.pay", name: "Pay" } }), {
        root,
      }),
      build: { outDir },
    });
    expect(await readdir(outDir)).toContain("sw.js");
    const worker = await readFile(join(outDir, "sw.js"), "utf8");
    expect(worker).toContain(String(/^\/settings\/?(?:\?.*)?$/i));
    expect(worker).toContain(String(/^\/payment\/[^/]+\/?(?:\?.*)?$/i));
  }, 60_000);
});
