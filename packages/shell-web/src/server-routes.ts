import { request, type ServerResponse } from "node:http";

import { pagePattern, UNROUTED_HEADER, type UiManifest } from "@parlor/agent-ui";
import type { Connect, Plugin } from "vite";

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

/**
 * Vite answers what it has a file or module for. Every other request goes to the app's
 * server, as in a build, except a browser's request for a page route's document.
 */
export function serverRoutes(port: number, isPage: PageMatcher): Plugin {
  return {
    name: "parlor:server-routes",
    apply: "serve",
    configureServer: (server) => () => {
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
        if (document && isPage(path)) return serveDocument();
        forward(req, res, port, url, document ? serveDocument : undefined);
      });
    },
  };
}
