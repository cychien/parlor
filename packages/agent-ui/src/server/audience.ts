import { DEV_USER_ID, type Principal, type UserId, userOf } from "@parlor/core";

/**
 * Whose screens a request may see and drive: its scope and, once signed in, its user.
 * Without auth, or as the dev user, it is the scope itself. A key has its own, which no
 * screen joins.
 */
export function audienceOf(scope: string, principal: Principal | undefined): string {
  if (principal?.kind === "key") return `${scope}\u001fkey:${principal.keyId}`;
  return userAudience(scope, userOf(principal));
}

/** `audienceOf` for a known user: the sync stream only that user's tabs and computers hear. */
export function userAudience(scope: string, userId: UserId | undefined): string {
  return userId === undefined || userId === DEV_USER_ID
    ? scope
    : `${scope}\u001f${userId}`;
}

/**
 * The stream every tab and computer of one signed-in user hears, whatever scope each is in:
 * what belongs to the person rather than to a scope, such as their computers. Undefined
 * without a user, where `userAudience` already reaches everyone.
 */
export function accountAudience(userId: UserId | undefined): string | undefined {
  return userId === undefined || userId === DEV_USER_ID ? undefined : `\u001f${userId}`;
}
