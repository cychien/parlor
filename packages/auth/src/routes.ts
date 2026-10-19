import {
  type AnyPluginRoute,
  type PluginHost,
  pluginRoute,
  type PublicPluginRoute,
} from "@parlor/server";

import { AUTH_PLUGIN, CONSENT_PATH, type ParlorAuthSettings } from "./better-auth.js";
import { escape, failure, page } from "./pages.js";
import type { BetterAuthInstance } from "./provider.js";

interface RouteDeps {
  readonly instance: BetterAuthInstance;
  readonly settings: ParlorAuthSettings;
  readonly host: PluginHost;
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
