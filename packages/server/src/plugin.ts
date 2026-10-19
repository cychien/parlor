import type {
  ActionErrorCode,
  ActionSource,
  AuthenticatedPrincipal,
  DataProvider,
  Principal,
  Tag,
} from "@parlor/core";
import type { ActionRegistry } from "@parlor/core/registry";
import type { ServerChannel } from "@parlor/sync";

import type { CallerOf } from "./access.js";
import type { AuthProvider } from "./auth.js";
import type { Caller } from "./caller.js";

/**
 * A framework feature the app installs with `createServer({ plugins })`. It owns the
 * tables prefixed `parlor_<name>_` and every path under `/_parlor/<name>/`.
 */
export interface ServerPlugin {
  readonly name: string;
  readonly migrations?: readonly Migration[] | undefined;
  setup(host: PluginHost): PluginRuntime;
}

/** Applied once per database in list order. An applied id must never change. */
export interface Migration {
  readonly id: `${string}/${number}_${string}`;
  readonly sql: string;
}

export interface PluginRuntime {
  /**
   * Served at `POST /_parlor/<plugin>/actions/<action>` through the same runner as the app's
   * actions, but never listed on MCP and never callable by an agent.
   */
  readonly actions?: ActionRegistry | undefined;
  readonly channel?: ServerChannel | undefined;
  readonly routes?: readonly AnyPluginRoute[] | undefined;
  /** Called once per action call on every surface after it settles, whatever the outcome. */
  audit?(record: ActionAudit): void;
  /** Runs before `close()` awaits in-flight requests, so it must end what it holds open. */
  close?(): void | Promise<void>;
}

export interface ActionAudit {
  readonly at: number;
  readonly action: string;
  readonly principal: Principal;
  readonly source: ActionSource;
  readonly scope: string;
  /** SHA-256 of the input as received; the input itself is not kept. */
  readonly inputDigest: string;
  /** `ran` once `run` started; `refused` when the call stopped before it. */
  readonly stage: "refused" | "ran";
  readonly outcome: "ok" | "cancelled" | ActionErrorCode;
  readonly confirmation?: ConfirmationAnswer | undefined;
}

export type ConfirmationAnswer = "approved" | "declined" | "timeout" | "unavailable";

type SignedInKind = AuthenticatedPrincipal["kind"];

/**
 * A plain route with no transaction or sync event. `access` decides who may call it and
 * types the caller its handler receives. An anonymous caller is admitted only when `access`
 * lists it and no enforcing auth provider is installed.
 */
export interface PluginRoute<K extends SignedInKind | "anonymous"> {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly access: readonly K[];
  handle(request: Request, caller: CallerOf<K>): Promise<Response>;
}

/** Callable by anyone, signed in or not: sign-in pages, OAuth endpoints. */
export interface PublicPluginRoute {
  readonly method: "GET" | "POST";
  /** Absolute when it starts with `/.well-known/`. */
  readonly path: `/${string}`;
  readonly access: "public";
  handle(request: Request): Promise<Response>;
}

export type AnyPluginRoute = PluginRoute<SignedInKind | "anonymous"> | PublicPluginRoute;

/** Infers `K` from `access`, so the handler's caller type follows the list. */
export function pluginRoute<const K extends SignedInKind | "anonymous">(
  route: PluginRoute<K>,
): PluginRoute<K> {
  return route;
}

export interface PluginHost {
  readonly basePath: string;
  readonly database: DataProvider | undefined;
  /** The installed auth provider, for plugins that mint or look up credentials (chat). */
  readonly auth?: AuthProvider | undefined;
  callerOf(request: Request): Promise<Caller>;
  /**
   * Records a sync event for writes made outside an action's transaction, such as through
   * a library that holds its own connection. Does nothing when sync is off.
   */
  announce(scope: string, tags: readonly Tag[]): Promise<void>;
}
