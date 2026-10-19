import type { SessionStore } from "./interface.js";

export const SESSION_STORAGE_KEY = "parlor.session";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The baseline for native shells until their keystore adapters land: the webview's own storage. */
export function localSessionStore(storage: StorageLike): SessionStore {
  return {
    get: () => Promise.resolve(storage.getItem(SESSION_STORAGE_KEY) ?? undefined),
    set: (token) => {
      if (token === undefined) storage.removeItem(SESSION_STORAGE_KEY);
      else storage.setItem(SESSION_STORAGE_KEY, token);
      return Promise.resolve();
    },
  };
}
