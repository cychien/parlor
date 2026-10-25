// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { appServer, page, type Received, render, TEMPLATE } from "./app.testing.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRenderer", () => {
  it("renders a page every matched route opts into, with its loader data and head", async () => {
    const server = appServer();
    const response = await render(
      page("/tasks/7", { cookie: "session=s1", "x-other": "no" }),
      {
        template: TEMPLATE,
        fetch: server.fetch,
        nonce: "n0nce",
      },
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/html");
    const html = await response!.text();
    expect(html).toMatch(
      /^<!doctype html><html lang="en"><head><meta charset="UTF-8" \/>/,
    );
    expect(html).toContain("<title>Task 7 · Tasks</title>");
    expect(html).not.toContain("<title>App</title>");
    expect(html).toContain('<meta property="og:title" content="Task 7" nonce="n0nce"/>');
    expect(html).toContain(
      '<meta property="og:site_name" content="Tasks" nonce="n0nce"/>',
    );
    expect(html).toContain('<link rel="stylesheet" href="/app.css" />');
    expect(html).toMatch(
      /<div id="root" data-parlor-ssr><nav aria-labelledby="(\w+)"><span id="\1">Tasks app<\/span><\/nav><!--\$--><h1>Task 7<\/h1>/,
    );
    expect(html).toContain(
      '<script type="module" src="/main.js"></script></body></html>',
    );
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);
    const inline = scripts.filter((tag) => !tag.includes("src="));
    expect(inline.length).toBeGreaterThan(0);
    for (const tag of inline) expect(tag).toContain('nonce="n0nce"');
    expect(html).toContain("parlorQueryCache");

    expect(server.received.map(({ path }) => path)).toEqual(["/_parlor/actions/getTask"]);
    const [{ headers }] = server.received as [Received];
    expect(headers.get("cookie")).toBe("session=s1");
    expect(headers.get("x-other")).toBeNull();
    expect(headers.get("x-parlor-source")).toBe("ui");
  });

  it("forwards the request's authorization to the app's server", async () => {
    const server = appServer();
    await render(page("/tasks/7", { authorization: "Bearer t1" }), {
      template: TEMPLATE,
      fetch: server.fetch,
      nonce: "n",
    });
    expect(server.received[0]?.headers.get("authorization")).toBe("Bearer t1");
  });

  it("leaves a page with a route that does not opt in to the browser, before any loader runs", async () => {
    const server = appServer();
    const options = { template: TEMPLATE, fetch: server.fetch, nonce: "n" };
    await expect(render(page("/settings"), options)).resolves.toBeUndefined();
    await expect(render(page("/maybe"), options)).resolves.toBeUndefined();
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("answers a loader's redirect and notFound like the browser would", async () => {
    const server = appServer();
    const options = { template: TEMPLATE, fetch: server.fetch, nonce: "n" };
    const moved = await render(page("/tasks/old"), options);
    expect(moved?.status).toBe(307);
    expect(moved?.headers.get("location")).toBe("/tasks/1");

    const missing = await render(page("/tasks/gone"), options);
    expect(missing?.status).toBe(404);
    await expect(missing!.text()).resolves.toContain("<p>No such task</p>");
  });

  it("leaves a template without a root container to the browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = appServer();
    await expect(
      render(page("/tasks/7"), {
        template: "<!doctype html><html><head></head><body><main></main></body></html>",
        fetch: server.fetch,
        nonce: "n",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
