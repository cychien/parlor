import { accountAudience, audienceOf } from "@parlor/agent-ui/server";
import {
  ActionError,
  ANONYMOUS,
  type ActionSource,
  type Principal,
  sourceOfPrincipal,
  userOf,
} from "@parlor/core";

import type { Surface } from "./access.js";
import type { AuthProvider } from "./auth.js";
import { CLIENT_HEADER, SOURCE_HEADER } from "./protocol.js";
import type { ScopeResolver } from "./scope.js";

export interface Caller {
  readonly principal: Principal;
  readonly scope: string;
  /** Scope plus user: whose screens this caller may see and drive (`audienceOf`). */
  readonly audience: string;
  /** The user's stream across scopes (`accountAudience`); undefined for a key or no user. */
  readonly account: string | undefined;
  /** The tab or app the request came from: a routing hint, never an identity. */
  readonly clientId: string | undefined;
}

/** The sync streams a caller hears: its scope's, its own in the scope, and its account's. */
export function streamsOf(caller: Caller): string[] {
  return [
    ...new Set(
      [caller.scope, caller.audience, caller.account].filter(
        (stream) => stream !== undefined,
      ),
    ),
  ];
}

export interface CallerResolver {
  (request: Request): Promise<Caller>;
  readonly enforcing: boolean;
}

const SOURCES: ReadonlySet<string> = new Set<ActionSource>([
  "ui",
  "agent",
  "http",
  "mcp",
]);

export function sourceOf(request: Request): ActionSource {
  const header = request.headers.get(SOURCE_HEADER);
  return header && SOURCES.has(header) ? (header as ActionSource) : "http";
}

export function clientOf(request: Request): string | undefined {
  return request.headers.get(CLIENT_HEADER) ?? undefined;
}

/** A key's source follows the surface it calls through: `mcp` on MCP, `http` elsewhere. */
export function sourceFor(
  declared: ActionSource,
  caller: Caller,
  enforcing: boolean,
  surface?: Surface,
): ActionSource {
  const { principal } = caller;
  if (principal.kind === "anonymous" && !enforcing) return declared;
  if (principal.kind === "key") return surface === "mcp" ? "mcp" : "http";
  return sourceOfPrincipal(principal);
}

/** `prepare` runs before the provider sees a request, so its tables exist by then. */
export function createCallerResolver(
  auth: AuthProvider | undefined,
  scope: ScopeResolver,
  prepare?: () => Promise<void>,
): CallerResolver {
  const callers = new WeakMap<Request, Promise<Caller>>();
  const resolve = async (request: Request): Promise<Caller> => {
    if (auth) await prepare?.();
    const principal = auth ? await auth.authenticate(request) : ANONYMOUS;
    const resolvedScope = await scope(request, principal);
    if (principal.kind === "key" && resolvedScope !== principal.scope) {
      throw new ActionError("forbidden", "This key acts only in its own scope.");
    }
    const turnScope = principal.kind === "agent" ? principal.turn?.scope : undefined;
    if (turnScope !== undefined && resolvedScope !== turnScope) {
      throw new ActionError(
        "forbidden",
        "This turn acts only in its conversation's scope.",
      );
    }
    return {
      principal,
      scope: resolvedScope,
      audience: audienceOf(resolvedScope, principal),
      account: principal.kind === "key" ? undefined : accountAudience(userOf(principal)),
      clientId: clientOf(request),
    };
  };
  return Object.assign(
    (request: Request) => {
      let caller = callers.get(request);
      if (!caller) {
        caller = resolve(request);
        callers.set(request, caller);
      }
      return caller;
    },
    { enforcing: auth?.enforcing === true },
  );
}
