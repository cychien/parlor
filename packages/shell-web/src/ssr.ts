import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import type { ParlorConfig } from "@parlor/config";
import { isRunnableDevEnvironment, type Plugin, type ViteDevServer } from "vite";

/** Exports `render`, the app's server renderer from `@parlor/client/ssr`. */
export const RENDER_MODULE = "virtual:parlor/render";
const RESOLVED_RENDER_MODULE = `\0${RENDER_MODULE}`;
export const RENDER_FILE = "render.mjs";

interface RenderOptions {
  readonly template: string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly nonce: string;
}

type RenderPage = (
  request: Request,
  options: RenderOptions,
) => Promise<Response | undefined>;

export function renderModule(config: ParlorConfig, root: string): Plugin {
  return {
    name: "parlor:render-module",
    resolveId: (id) => (id === RENDER_MODULE ? RESOLVED_RENDER_MODULE : undefined),
    load(id) {
      if (id !== RESOLVED_RENDER_MODULE || !config.web.ssr) return undefined;
      return [
        `import createApp from ${JSON.stringify(resolve(root, config.web.ssr.app))};`,
        'import { createRenderer } from "@parlor/client/ssr";',
        "export const render = createRenderer(createApp);",
      ].join("\n");
    },
  };
}

export function createNonce(): string {
  return randomBytes(16).toString("base64");
}

function requestHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    for (const item of Array.isArray(value) ? value : [value]) result.append(name, item);
  }
  return result;
}

/**
 * What `parlor dev` serves for a page route's document: the page rendered as the build would,
 * or undefined to serve `index.html` when it does not render on the server.
 */
export async function renderInDev(
  server: ViteDevServer,
  serverPort: number,
  url: string,
  headers: IncomingHttpHeaders,
): Promise<Response | undefined> {
  const environment = server.environments.ssr;
  if (!environment || !isRunnableDevEnvironment(environment)) return undefined;
  const html = await readFile(join(server.config.root, "index.html"), "utf8");
  const template = await server.transformIndexHtml(url, html);
  const { render } = (await environment.runner.import(RENDER_MODULE)) as {
    readonly render: RenderPage;
  };
  const request = new Request(new URL(url, `http://${headers.host ?? "localhost"}`), {
    headers: requestHeaders(headers),
  });
  return render(request, {
    template,
    nonce: createNonce(),
    fetch: async (action) => {
      const { pathname, search } = new URL(action.url);
      return fetch(`http://localhost:${serverPort}${pathname}${search}`, {
        method: action.method,
        headers: action.headers,
        body: action.method === "GET" ? null : await action.arrayBuffer(),
      });
    },
  });
}

export async function sendResponse(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}
