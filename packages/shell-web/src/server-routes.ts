import { request, type ServerResponse } from "node:http";

import { pagePattern, UNROUTED_HEADER, type UiManifest } from "@parlor/agent-ui";
import type { Connect, Plugin } from "vite";

import { renderInDev, sendResponse } from "./ssr.js";

export type PageMatcher = (path: string) => boolean;

export function pageMatcher(manifest: () => UiManifest | undefined): PageMatcher {
  let seen: UiManifest | undefined;
  let patterns: RegExp[] = [];
  return (path) => {
    const current = manifest();
    if (current !== seen) {
      seen = current;
      patterns = current?.routes.map((route) => pagePattern(route.path)) ?? [];
    }
    return patterns.some((pattern) => pattern.test(path));
  };
}

function forward(
  req: Connect.IncomingMessage,
  res: ServerResponse,
  port: number,
  url: string,
  unrouted: (() => void) | undefined,
): void {
  const upstream = request(
    { host: "localhost", port, method: req.method, path: url, headers: req.headers },
    (response) => {
      if (unrouted && response.statusCode === 404 && response.headers[UNROUTED_HEADER]) {
        response.resume();
        unrouted();
        return;
      }
      res.removeHeader("content-security-policy");
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else if (unrouted) unrouted();
    else res.writeHead(502).end();
  });
  req.pipe(upstream);
}

export interface ServerRoutesOptions {
  /** Renders a page route's document on the server first, as a build with `web.ssr` does. */
  readonly render?: boolean | undefined;
}

/**
 * Vite answers what it has a file or module for. Every other request goes to the app's
 * server, as in a build, except a browser's request for a page route's document.
 */
export function serverRoutes(
  port: number,
  isPage: PageMatcher,
  options: ServerRoutesOptions = {},
): Plugin {
  return {
    name: "parlor:server-routes",
    apply: "serve",
    configureServer: (server) => () => {
      const renderPage = async (
        req: Connect.IncomingMessage,
        res: ServerResponse,
        url: string,
        fallback: () => void,
      ) => {
        try {
          const page = await renderInDev(server, port, url, req.headers);
          if (page) return await sendResponse(page, res);
        } catch (error) {
          if (error instanceof Error) server.ssrFixStacktrace(error);
          server.config.logger.error(
            `[parlor] Rendering ${url} on the server failed, so it is served without: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          );
          if (res.headersSent) return void res.end();
        }
        fallback();
      };
      server.middlewares.use((req, res, next) => {
        const url = req.originalUrl ?? req.url ?? "/";
        const path = url.split("?")[0] ?? "/";
        if (path.endsWith(".html")) return next();
        const document =
          req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
        const serveDocument = () => {
          req.url = "/index.html";
          next();
        };
        if (document && isPage(path)) {
          if (options.render) return void renderPage(req, res, url, serveDocument);
          return serveDocument();
        }
        forward(req, res, port, url, document ? serveDocument : undefined);
      });
    },
  };
}
