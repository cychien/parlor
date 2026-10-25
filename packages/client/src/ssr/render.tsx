import { type AnyRouter, RouterContextProvider, Scripts } from "@tanstack/react-router";
import {
  createRequestHandler,
  getSsrStatus,
  transformHtmlStringWithRouter,
} from "@tanstack/react-router/ssr/server";
import { createElement, type ReactNode } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";

import { createActionClient } from "../action-client.js";
import { type CreateParlorApp, SERVER_RENDERED } from "../router/mount.js";

export interface RenderOptions {
  /** The app's `index.html` as the browser gets it; the page renders into its `#root`. */
  readonly template: string;
  /** Reaches the app's server: in process, through its Durable Object, or over the network in dev. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Goes on every inline script; the response's policy allows it. */
  readonly nonce: string;
}

/** The page, or undefined when a route it matches does not render on the server. */
export type RenderPage = (
  request: Request,
  options: RenderOptions,
) => Promise<Response | undefined>;

const FORWARDED_HEADERS = ["cookie", "authorization"] as const;
const APP_TAG = "parlor-app";
const CONTAINER = /<([a-z][\w-]*)(\s[^>]*?\bid=(["']?)root\3(?:\s[^>]*)?)>\s*<\/\1>/i;
const TITLE = /<title[\s>]/i;
const TEMPLATE_TITLE = /\s*<title[^>]*>[\s\S]*?<\/title>/i;

let warnedNoContainer = false;

function forwarded(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) kept[name] = value;
  }
  return kept;
}

/** A route that says it never renders on the server settles it before any loader runs. */
function declined(router: AnyRouter, pathname: string): boolean {
  const [routes] = router.getMatchedRoutes(pathname);
  return routes.some((route) => {
    const ssr = route.options.ssr ?? router.options.defaultSsr ?? true;
    return ssr === false || ssr === "data-only";
  });
}

/**
 * Every element above the app has one child, so `useId` counts as it does from the browser's
 * root. The router's scripts render after the app, once it has taken what loaders dehydrated.
 */
async function renderDocument(
  router: AnyRouter,
  element: ReactNode,
  nonce: string,
): Promise<string> {
  const stream = await renderToReadableStream(
    <html>
      <body>{createElement(APP_TAG, null, element)}</body>
    </html>,
    {
      nonce,
      progressiveChunkSize: Number.POSITIVE_INFINITY,
      onError: (error) => console.error("[parlor] Server render:", error),
    },
  );
  await stream.allReady;
  const app = await new Response(stream).text();
  const scripts = renderToString(
    <RouterContextProvider router={router}>
      <Scripts />
    </RouterContextProvider>,
  );
  const html = app
    .replace(/^<!DOCTYPE html>/i, "")
    .replace("</body>", () => `${scripts}</body>`);
  return transformHtmlStringWithRouter(router, html);
}

/** React renders the app and hoists its head tags; the template keeps everything else. */
function intoTemplate(template: string, rendered: string): string {
  const head = rendered.slice(
    rendered.indexOf("<head>") + "<head>".length,
    rendered.indexOf("</head>"),
  );
  const appStart = rendered.indexOf(`<${APP_TAG}>`) + `<${APP_TAG}>`.length;
  const appEnd = rendered.lastIndexOf(`</${APP_TAG}>`);
  const scripts = rendered.slice(
    appEnd + `</${APP_TAG}>`.length,
    rendered.lastIndexOf("</body>"),
  );
  const headEnd = template.indexOf("</head>");
  const templateHead = template.slice(0, headEnd);
  const shell = `${TITLE.test(head) ? templateHead.replace(TEMPLATE_TITLE, "") : templateHead}${head}${template.slice(headEnd)}`;
  return shell.replace(
    CONTAINER,
    (_match, tag: string, attributes: string) =>
      `<${tag}${attributes} ${SERVER_RENDERED}>${rendered.slice(appStart, appEnd)}</${tag}>${scripts}`,
  );
}

/**
 * Renders one document request with TanStack Router's SSR handler: the loaders run against
 * the app's server with the request's cookie and authorization, then React renders the
 * matched routes and the router's state, query cache included, goes along for hydration.
 */
export function createRenderer(createApp: CreateParlorApp): RenderPage {
  return async (request, { template, fetch, nonce }) => {
    if (!CONTAINER.test(template)) {
      if (!warnedNoContainer) {
        warnedNoContainer = true;
        console.warn(
          '[parlor] index.html has no empty element with id="root", so pages are not rendered on the server.',
        );
      }
      return undefined;
    }
    const url = new URL(request.url);
    const { router, element } = createApp(
      createActionClient({
        baseUrl: url.origin,
        fetch: (input, init) => fetch(new Request(input, init)),
        headers: forwarded(request.headers),
      }),
    );
    if (declined(router, url.pathname)) return undefined;
    router.update({ ...router.options, ssr: { nonce } });

    const notRendered = new Response();
    const response = await createRequestHandler({ request, createRouter: () => router })(
      async ({ responseHeaders }) => {
        if (!router.state.matches.every((match) => match.ssr === true))
          return notRendered;
        const page = intoTemplate(template, await renderDocument(router, element, nonce));
        return new Response(page, {
          status: getSsrStatus(router),
          headers: responseHeaders,
        });
      },
    );
    return response === notRendered ? undefined : response;
  };
}
