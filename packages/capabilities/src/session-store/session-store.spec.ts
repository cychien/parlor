import { afterEach, describe, expect, it } from "vitest";

import { resolveCapability } from "../capability.js";
import { capacitorSessionStore } from "./capacitor.js";
import { localSessionStore, SESSION_STORAGE_KEY, type StorageLike } from "./local.js";
import { tauriSessionStore } from "./tauri.js";
import { webSessionStore } from "./web.js";

function memoryStorage(): StorageLike & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const globals = globalThis as { __TAURI_INTERNALS__?: unknown; Capacitor?: unknown };
afterEach(() => {
  delete globals.__TAURI_INTERNALS__;
  delete globals.Capacitor;
});

describe("localSessionStore", () => {
  it("keeps a token until it is cleared", async () => {
    const storage = memoryStorage();
    const store = localSessionStore(storage);
    expect(await store.get()).toBeUndefined();
    await store.set("token-1");
    expect(storage.items.get(SESSION_STORAGE_KEY)).toBe("token-1");
    expect(await store.get()).toBe("token-1");
    await store.set(undefined);
    expect(await store.get()).toBeUndefined();
  });
});

describe("webSessionStore", () => {
  it("is never available, so the browser keeps its cookie", async () => {
    const handle = await resolveCapability(
      { name: "sessionStore", adapters: [webSessionStore()] },
      "web",
    );
    expect(handle.available).toBe(false);
  });
});

describe("tauriSessionStore", () => {
  it("stores the token in the webview inside a Tauri shell only", async () => {
    const storage = memoryStorage();
    const adapter = tauriSessionStore(() => storage);
    expect(adapter.available()).toBe(false);
    globals.__TAURI_INTERNALS__ = {};
    expect(adapter.available()).toBe(true);
    await (await adapter.create()).set("tauri-token");
    expect(storage.items.get(SESSION_STORAGE_KEY)).toBe("tauri-token");
  });
});

describe("capacitorSessionStore", () => {
  it("stores the token in the webview inside a native Capacitor shell only", async () => {
    const storage = memoryStorage();
    const adapter = capacitorSessionStore(() => storage);
    expect(adapter.available()).toBe(false);
    globals.Capacitor = { isNativePlatform: () => true };
    expect(adapter.available()).toBe(true);
    await (await adapter.create()).set("capacitor-token");
    expect(storage.items.get(SESSION_STORAGE_KEY)).toBe("capacitor-token");
  });
});
