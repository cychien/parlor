import type { SessionStore } from "./interface.js";
import { SESSION_STORAGE_KEY, type StorageLike } from "./local.js";

export interface NativeSession {
  get(): Promise<string | undefined>;
  set(token: string | undefined): Promise<void>;
}

/**
 * The token lives in the platform keychain only. A token an earlier release left in the
 * webview's storage moves over on the first read and is deleted there; a failed move is
 * retried by the next call.
 */
export function keychainSessionStore(
  native: NativeSession,
  legacy: StorageLike,
): SessionStore {
  let migrated: Promise<void> | undefined;
  const move = async () => {
    const old = legacy.getItem(SESSION_STORAGE_KEY);
    if (old === null) return;
    if ((await native.get()) === undefined) await native.set(old);
    legacy.removeItem(SESSION_STORAGE_KEY);
  };
  const migrate = () => {
    const attempt = (migrated ??= move());
    attempt.catch(() => {
      if (migrated === attempt) migrated = undefined;
    });
    return attempt;
  };
  return {
    get: async () => {
      await migrate();
      return native.get();
    },
    set: async (token) => {
      await migrate();
      await native.set(token);
    },
  };
}
