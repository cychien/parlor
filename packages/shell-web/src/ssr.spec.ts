import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig } from "@parlor/config";
import { build, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { parlorWeb } from "./plugin.js";

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
/** Inside this package, so the app resolves React, the router and `@parlor/client`. */
const GENERATED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".parlor");

const APP = `
import { ensureActionQueryData, FrameworkProvider, useActionSuspenseQuery } from "@parlor/client/react";
import { createParlorRouter } from "@parlor/client/router";
import { createRootRouteWithContext, createRoute, HeadContent, Outlet, RouterProvider } from "@tanstack/react-router";

const root = createRootRouteWithContext()({
  ssr: true,
  component: () => <><HeadContent /><Outlet /></>,
});

function TaskPage() {
  const { taskId } = taskRoute.useParams();
  const { data } = useActionSuspenseQuery("getTask", { id: taskId });
  return <h1>{data.title}</h1>;
}

const taskRoute = createRoute({
  getParentRoute: () => root,
  path: "/tasks/$taskId",
  ssr: true,
  loader: ({ context, params }) => ensureActionQueryData(context, "getTask", { id: params.taskId }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title }] }),
  component: TaskPage,
});

export const routeTree = root.addChildren([
  taskRoute,
  createRoute({ getParentRoute: () => root, path: "/settings", component: () => <p>settings</p> }),
]);

export default function createApp(client) {
  const router = createParlorRouter({ routeTree, client });
  return {
    router,
    element: (
      <FrameworkProvider client={client} router={router} sync={false}>
        <RouterProvider router={router} />
      </FrameworkProvider>
    ),
  };
}
`;

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function app(source = APP, files: Record<string, string> = {}): Promise<string> {
  await mkdir(GENERATED_DIR, { recursive: true });
  const root = await mkdtemp(join(GENERATED_DIR, "ssr-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><head><title>spa</title></head><body><div id="root"></div><script type="module" src="/main.ts"></script></body></html>',
  );
  await writeFile(join(root, "main.ts"), "export {};");
  await writeFile(join(root, "src", "app.tsx"), source);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(
    join(root, "src", "routeTree.gen.ts"),
    'export { routeTree } from "./app.tsx";\n',
  );
  return root;
}

async function appServer(): Promise<{ port: number; cookies: (string | undefined)[] }> {
  const cookies: (string | undefined)[] = [];
  const server: Server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/_parlor/actions/getTask") {
        cookies.push(request.headers.cookie);
        const { id } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string };
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: { id, title: `Task ${id}` }, tags: [] }));
        return;
      }
      response
        .writeHead(404, { "x-parlor-unrouted": "1" })
        .end(JSON.stringify({ error: { code: "not_found" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as AddressInfo).port, cookies };
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

async function devServer(root: string, upstreamPort: number): Promise<string> {
  const config = parseConfig({
    app: { id: "com.example.tasks", name: "Tasks" },
    server: { port: upstreamPort },
    web: { port: await freePort(), pwa: false, ssr: { app: "src/app.tsx" } },
  });
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: parlorWeb(config, { root }),
  });
  await vite.listen();
  closers.push(() => vite.close());
  for (let i = 0; ; i++) {
    const ready = await access(join(root, ".parlor", "ui-manifest.json")).then(
      () => true,
      () => false,
    );
    if (ready) break;
    if (i === 100) throw new Error("no manifest");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return `http://localhost:${config.web.port}`;
}

describe("parlor dev with web.ssr", () => {
  it("renders an opted-in page's document on the server, as the build does", async () => {
    const root = await app();
    const upstream = await appServer();
    const origin = await devServer(root, upstream.port);
    const browse = (path: string) =>
      fetch(`${origin}${path}`, {
        headers: { accept: BROWSER_ACCEPT, cookie: "session=ok" },
      });

    const page = await browse("/tasks/7");
    const html = await page.text();
    expect(html).toContain('<div id="root" data-parlor-ssr><!--$--><h1>Task 7</h1>');
    expect(html).toContain("<title>Task 7</title>");
    expect(html).not.toContain("<title>spa</title>");
    expect(html).toContain('<script type="module" src="/@vite/client"></script>');
    expect(upstream.cookies).toEqual(["session=ok"]);

    const settings = await browse("/settings");
    const spa = await settings.text();
    expect(spa).toContain("<title>spa</title>");
    expect(spa).not.toContain("data-parlor-ssr");
  }, 60_000);

  it("runs Parlor's packages through Vite when they are installed from a registry", async () => {
    const root = await app(
      APP.replace(
        "return <h1>{data.title}</h1>;",
        "return <h1>{`${data.title} ${mode}`}</h1>;",
      ).replace(
        'import { createParlorRouter } from "@parlor/client/router";',
        'import { createParlorRouter } from "@parlor/client/router";\nimport { mode } from "@parlor/env-reader";',
      ),
      {
        "node_modules/@parlor/env-reader/package.json": JSON.stringify({
          name: "@parlor/env-reader",
          type: "module",
          exports: "./index.js",
        }),
        "node_modules/@parlor/env-reader/index.js":
          'export const mode = import.meta.env.DEV ? "dev" : "build";\n',
      },
    );
    const upstream = await appServer();
    const origin = await devServer(root, upstream.port);

    const page = await fetch(`${origin}/tasks/7`, {
      headers: { accept: BROWSER_ACCEPT },
    });
    await expect(page.text()).resolves.toContain("<h1>Task 7 dev</h1>");
  }, 60_000);
});

describe("the service worker of an app with web.ssr", () => {
  it("leaves documents to the server", async () => {
    const root = await app();
    const outDir = join(root, "out");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: parlorWeb(
        parseConfig({
          app: { id: "com.example.tasks", name: "Tasks" },
          web: { ssr: { app: "src/app.tsx" } },
        }),
        { root },
      ),
      build: { outDir },
    });
    const worker = await readFile(join(outDir, "sw.js"), "utf8");
    expect(worker).not.toContain("NavigationRoute");
    expect(worker).not.toContain('url:"index.html"');
    expect(worker).toContain("registerSW.js");
  }, 60_000);
});
