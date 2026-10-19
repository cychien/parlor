import {
  ActionError,
  type AuthenticatedPrincipal,
  type Principal,
  type PrincipalKind,
} from "@parlor/core";

import type { Caller } from "./caller.js";

type SignedInKind = AuthenticatedPrincipal["kind"];

export const ROUTE_ACCESS = {
  manifest: ["user", "agent"],
  actions: ["user", "agent"],
  pluginActions: ["user", "host"],
  mcp: ["agent"],
  sync: ["user", "host"],
  channels: ["user"],
  ui: ["user"],
} as const satisfies Record<string, readonly SignedInKind[]>;

export type Surface = keyof typeof ROUTE_ACCESS;

/** Reached by anonymous callers even under an enforcing provider; each action checks `public`. */
const OPEN_WHEN_ENFORCING: ReadonlySet<Surface> = new Set<Surface>(["actions"]);

/** An anonymous caller reaches every surface while no enforcing provider is installed. */
export type KindsOf<S extends Surface> = "anonymous" | (typeof ROUTE_ACCESS)[S][number];

export type CallerOf<K extends PrincipalKind> = Caller & {
  readonly principal: Extract<Principal, { readonly kind: K }>;
};

export function admits(surface: Surface, caller: Caller, enforcing: boolean): boolean {
  const { kind } = caller.principal;
  if (kind === "anonymous") return !enforcing || OPEN_WHEN_ENFORCING.has(surface);
  return (ROUTE_ACCESS[surface] as readonly SignedInKind[]).includes(kind);
}

/**
 * Narrows a caller to the kinds a surface admits, or refuses it: `unauthenticated` for an
 * anonymous caller, `forbidden` for a signed-in principal of another kind.
 */
export function requireSurface<S extends Surface>(
  caller: Caller,
  surface: S,
  enforcing: boolean,
): CallerOf<KindsOf<S>> {
  if (admits(surface, caller, enforcing)) return caller as CallerOf<KindsOf<S>>;
  const { kind } = caller.principal;
  if (kind === "anonymous") throw new ActionError("unauthenticated", "Sign in first.");
  throw new ActionError("forbidden", `A ${kind} principal cannot use ${surface}.`);
}

export function requireAccess<K extends PrincipalKind>(
  caller: Caller,
  kinds: readonly K[],
  enforcing: boolean,
): CallerOf<K> {
  const { kind } = caller.principal;
  const listed = (kinds as readonly PrincipalKind[]).includes(kind);
  if (kind === "anonymous" && (enforcing || !listed)) {
    throw new ActionError("unauthenticated", "Sign in first.");
  }
  if (!listed) throw new ActionError("forbidden", `A ${kind} principal cannot use this.`);
  return caller as CallerOf<K>;
}
