import { asId, type UserId } from "@parlor/core";

import type { AuthProvider } from "./auth.js";

export const DEV_AUTH_PLUGIN = "dev-auth";

export const DEV_USER_ID: UserId = asId("user", "dev");

/** `POST /_parlor/dev-auth/host`: mints the dev host token for a loopback caller. */
export const DEV_HOST_PATH = "/host";

export interface DevAuthOptions {
  readonly secret?: Uint8Array | undefined;
}

/**
 * What `parlor dev` installs when the app has no auth provider. Not enforcing, so the
 * browser and external MCP clients keep today's anonymous, header-declared behavior; it
 * only adds the host and turn tokens the local inline agent needs.
 */
export function devAuth(options: DevAuthOptions = {}): AuthProvider {
  // TODO: secret = options.secret ?? 32 random bytes, per process (a restart revokes all).
  //   authenticate: no credential -> ANONYMOUS; `Bearer dev-host.<hostId>.<mac>` -> host
  //   { userId: DEV_USER_ID, grantId: "dev", hostId }; `Bearer dev-turn.<claims>.<mac>`
  //   -> agentPrincipalOf-like agent with turn; a bad mac -> AuthFailure("invalid").
  //   route DEV_HOST_PATH: refuse a non-loopback peer and any request with an Origin
  //   header, so no web page can mint it through the browser.
  //   delegate: HMAC turn token; revoked(): a signal that never aborts; device(): undefined.
  void options;
  throw new Error("not implemented");
}
