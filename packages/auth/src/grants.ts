import { asId, type GrantId } from "@parlor/core";

/** One grant per user and OAuth client; re-authorizing after a revocation mints newer tokens. */
export function grantIdOf(userId: string, clientId: string): GrantId {
  return asId("grant", `oauth:${userId}:${clientId}`);
}
