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

function keychain(initial?: string) {
  let value = initial;
  const calls: [string, unknown][] = [];
  return {
    calls,
    value: () => value,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === "parlor_session_get") return value ?? null;
      if (command === "parlor_session_set") {
        value = (args?.token as string | null) ?? undefined;
        return undefined;
      }
      throw new Error(`unexpected ${command}`);
    },
  };
}

describe("tauriSessionStore", () => {
  it("keeps the token in the Keychain, never in the webview", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const storage = memoryStorage();
    const native = keychain();
    const store = await tauriSessionStore(
      () => storage,
      async () => ({ invoke: native.invoke }) as never,
    ).create();
    expect(await store.get()).toBeUndefined();
    await store.set("tauri-token");
    expect(native.value()).toBe("tauri-token");
    expect(await store.get()).toBe("tauri-token");
    expect(storage.items.size).toBe(0);
    await store.set(undefined);
    expect(native.value()).toBeUndefined();
  });

  it("T6-05: moves a token an earlier release left in the webview into the Keychain, and deletes it there", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const storage = memoryStorage();
    storage.setItem(SESSION_STORAGE_KEY, "old-token");
    const native = keychain();
    const store = await tauriSessionStore(
      () => storage,
      async () => ({ invoke: native.invoke }) as never,
    ).create();
    expect(await store.get()).toBe("old-token");
    expect(native.value()).toBe("old-token");
    expect(storage.items.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it("keeps the Keychain's token when the webview still holds an older one", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const storage = memoryStorage();
    storage.setItem(SESSION_STORAGE_KEY, "stale");
    const native = keychain("fresh");
    const store = await tauriSessionStore(
      () => storage,
      async () => ({ invoke: native.invoke }) as never,
    ).create();
    expect(await store.get()).toBe("fresh");
    expect(storage.items.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it.each(["Command parlor_session_get not found", "unsupported"])(
    "stores the token in the webview in a shell whose session command is unavailable (%s)",
    async (failure) => {
      globals.__TAURI_INTERNALS__ = {};
      const storage = memoryStorage();
      const adapter = tauriSessionStore(
        () => storage,
        async () =>
          ({
            invoke: async () => {
              throw failure;
            },
          }) as never,
      );
      expect(adapter.available()).toBe(true);
      await (await adapter.create()).set("tauri-token");
      expect(storage.items.get(SESSION_STORAGE_KEY)).toBe("tauri-token");
    },
  );

  it("never asks whether a host is bundled", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const native = keychain();
    await tauriSessionStore(
      () => memoryStorage(),
      async () => ({ invoke: native.invoke }) as never,
    ).create();
    expect(native.calls.map(([command]) => command)).not.toContain("parlor_host_bundled");
  });

  it("is available inside a Tauri shell only", () => {
    const adapter = tauriSessionStore(() => memoryStorage());
    expect(adapter.available()).toBe(false);
    globals.__TAURI_INTERNALS__ = {};
    expect(adapter.available()).toBe(true);
  });
});

describe("capacitorSessionStore", () => {
  const plugin = (initial?: string) => {
    let value = initial;
    return {
      value: () => value,
      load: async () => ({
        ParlorSessionStore: {
          get: async () => (value === undefined ? {} : { value }),
          set: async (options: { value?: string }) => void (value = options.value),
        },
      }),
    };
  };

  it("is available inside a native Capacitor shell only", () => {
    const adapter = capacitorSessionStore(() => memoryStorage());
    expect(adapter.available()).toBe(false);
    globals.Capacitor = { isNativePlatform: () => true };
    expect(adapter.available()).toBe(true);
  });

  it("T6-05: keeps the token in the iOS Keychain and migrates the webview's old one", async () => {
    globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
    const storage = memoryStorage();
    storage.setItem(SESSION_STORAGE_KEY, "old-token");
    const native = plugin();
    const store = await capacitorSessionStore(() => storage, native.load).create();
    expect(await store.get()).toBe("old-token");
    expect(native.value()).toBe("old-token");
    expect(storage.items.size).toBe(0);
    await store.set("capacitor-token");
    expect(native.value()).toBe("capacitor-token");
    expect(storage.items.size).toBe(0);
    await store.set(undefined);
    expect(native.value()).toBeUndefined();
  });

  it("stores the token in the webview where the plugin has no implementation", async () => {
    globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
    const storage = memoryStorage();
    const store = await capacitorSessionStore(() => storage, plugin().load).create();
    await store.set("capacitor-token");
    expect(storage.items.get(SESSION_STORAGE_KEY)).toBe("capacitor-token");
  });
});
