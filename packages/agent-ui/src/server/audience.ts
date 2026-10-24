import { DEV_USER_ID, type Principal, type UserId, userOf } from "@parlor/core";

/**
 * Whose screens a request may see and drive: its scope and, once signed in, its user.
 * Without auth, or as the dev user, it is the scope itself.
 */
export function audienceOf(scope: string, principal: Principal | undefined): string {
  return userAudience(scope, userOf(principal));
}

/** `audienceOf` for a known user: the sync stream only that user's tabs and computers hear. */
export function userAudience(scope: string, userId: UserId | undefined): string {
  return userId === undefined || userId === DEV_USER_ID
    ? scope
    : `${scope}\u001f${userId}`;
}
