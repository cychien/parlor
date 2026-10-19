import { type Principal, type UserId, userOf } from "@parlor/core";

/**
 * Whose screens a request may see and drive: its scope and, once signed in, its user.
 * Without auth it is the scope itself.
 */
export function audienceOf(scope: string, principal: Principal | undefined): string {
  return userAudience(scope, userOf(principal));
}

function userAudience(scope: string, userId: UserId | undefined): string {
  return userId === undefined ? scope : `${scope}\u001f${userId}`;
}
