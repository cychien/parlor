import { createHash } from "node:crypto";

import {
  type AnyPluginRoute,
  type PluginHost,
  pluginRoute,
  type PublicPluginRoute,
} from "@parlor/server";

import { AUTH_PLUGIN, CONSENT_PATH, type ParlorAuthSettings } from "./better-auth.js";
import type { BetterAuthInstance } from "./provider.js";

interface RouteDeps {
  readonly instance: BetterAuthInstance;
  readonly settings: ParlorAuthSettings;
  readonly host: PluginHost;
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --text: #1d1d1b; --muted: #5f5f5a; --line: #e2e2dc; --accent: #1d1d1b; --on-accent: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1f1f1d; --text: #ededea; --muted: #a3a39d; --line: #34342f; --accent: #ededea; --on-accent: #151514; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
h1 { font-size: 20px; line-height: 1.3; margin: 0 0 8px; }
p { margin: 0 0 12px; color: var(--muted); }
ul { margin: 0 0 20px; padding-left: 20px; }
li { margin-bottom: 6px; }
strong { color: var(--text); font-weight: 600; }
form { display: flex; gap: 8px; justify-content: flex-end; margin: 0; }
button { font: inherit; font-weight: 600; padding: 9px 18px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer; }
button[value="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

function page(title: string, body: string, formAction: readonly string[]): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        `style-src 'sha256-${STYLE_HASH}'`,
        `form-action ${formAction.join(" ")}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      // no-referrer would make the form POST carry `Origin: null`.
      "referrer-policy": "same-origin",
    },
  });
}

function failure(message: string, status: number): Response {
  const response = page(
    "Authorization failed",
    `<h1>Authorization failed</h1><p>${escape(message)}</p>`,
    ["'none'"],
  );
  return new Response(response.body, { status, headers: response.headers });
}

/** A client's name is self-declared; only an https client id proves who publishes it. */
function publisherOf(clientId: string): string {
  if (!clientId.startsWith("https://"))
    return "This agent named itself; its publisher is not verified.";
  return `Published by <strong>${escape(new URL(clientId).host)}</strong>.`;
}

function redirectOrigin(query: URLSearchParams): string | undefined {
  try {
    return new URL(query.get("redirect_uri") ?? "").origin;
  } catch {
    return undefined;
  }
}

/**
 * Better Auth's endpoints under `/_parlor/auth`, the OAuth discovery documents MCP clients
 * read at the origin root, and the consent page an MCP client's authorization stops at.
 */
export function authRoutes({ instance, settings, host }: RouteDeps): AnyPluginRoute[] {
  const forward = (method: "GET" | "POST", path: `/${string}`): PublicPluginRoute => ({
    method,
    path,
    access: "public",
    handle: (request) => instance.handler(request),
  });
  const appName = () => instance.options.appName ?? new URL(settings.origin).host;

  const consentPage = pluginRoute({
    method: "GET",
    path: CONSENT_PATH,
    access: ["user"],
    handle: async (request) => {
      const query = new URL(request.url).searchParams;
      const clientId = query.get("client_id");
      const target = redirectOrigin(query);
      if (!clientId || !target || !query.get("sig")) {
        return failure("This authorization request is incomplete.", 400);
      }
      const session = await instance.api.getSession({ headers: request.headers });
      if (!session) return failure("Sign in again to continue.", 401);
      const { adapter } = await instance.$context;
      const client = await adapter.findOne<{ name?: string | null }>({
        model: "oauthClient",
        where: [{ field: "clientId", value: clientId }],
      });
      if (!client) return failure("This agent is not registered.", 400);
      const agent = client.name || clientId;
      const app = appName();
      const offline = (query.get("scope") ?? "").split(" ").includes("offline_access");
      const body = `
<h1>Allow ${escape(agent)} to use ${escape(app)}?</h1>
<p>${publisherOf(clientId)}</p>
<p>Signed in as <strong>${escape(session.user.email)}</strong>.</p>
<ul>
<li>It can do anything you can do in ${escape(app)}, as you. Actions that ask for confirmation still ask you first.</li>
<li>${offline ? "It stays connected until you revoke it in your account settings." : "Its access ends after a few minutes."}</li>
<li>You will be sent back to <strong>${escape(new URL(target).host)}</strong>.</li>
</ul>
<form method="post" action="${escape(`${host.basePath}/${AUTH_PLUGIN}${CONSENT_PATH}`)}">
<input type="hidden" name="oauth_query" value="${escape(query.toString())}">
<button type="submit" name="accept" value="false">Deny</button>
<button type="submit" name="accept" value="true" autofocus>Allow</button>
</form>`;
      return page(`Allow ${agent}?`, body, ["'self'", target]);
    },
  });

  const consentAnswer = pluginRoute({
    method: "POST",
    path: CONSENT_PATH,
    access: ["user"],
    handle: async (request) => {
      if (request.headers.get("origin") !== settings.origin) {
        return failure("This answer did not come from the consent page.", 403);
      }
      const form = new URLSearchParams(await request.text());
      const oauthQuery = form.get("oauth_query");
      const accept = form.get("accept");
      if (!oauthQuery || (accept !== "true" && accept !== "false")) {
        return failure("This answer is incomplete.", 400);
      }
      const headers = new Headers({
        "content-type": "application/json",
        accept: "application/json",
        origin: settings.origin,
      });
      const cookie = request.headers.get("cookie");
      if (cookie) headers.set("cookie", cookie);
      const answer = await instance.handler(
        new Request(`${settings.baseURL}/oauth2/consent`, {
          method: "POST",
          headers,
          body: JSON.stringify({ accept: accept === "true", oauth_query: oauthQuery }),
        }),
      );
      const result = (await answer.json().catch(() => undefined)) as
        | { url?: string; redirect_uri?: string; message?: string }
        | undefined;
      const location = result?.url ?? result?.redirect_uri;
      if (!answer.ok || !location) {
        return failure(
          result?.message ?? "The authorization could not be completed.",
          400,
        );
      }
      return new Response(null, { status: 303, headers: { location } });
    },
  });

  return [
    forward("GET", "/**"),
    forward("POST", "/**"),
    forward("GET", "/.well-known/oauth-protected-resource"),
    forward("GET", "/.well-known/oauth-protected-resource/**"),
    forward("GET", "/.well-known/oauth-authorization-server/**"),
    consentPage,
    consentAnswer,
  ];
}
