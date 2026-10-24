import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCapability } from "../capability.js";
import { capacitorAuthBrowser } from "./capacitor.js";
import { tauriAuthBrowser } from "./tauri.js";
import { webAuthBrowser } from "./web.js";

const globals = globalThis as {
  __TAURI_INTERNALS__?: unknown;
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
};

afterEach(() => {
  delete globals.__TAURI_INTERNALS__;
  delete globals.Capacitor;
});

const PAGE = "https://app.example.com/_parlor/auth/native/sign-in/social?provider=google";
const CALLBACK = "hello://_parlor/auth/callback";
const RETURNED = `${CALLBACK}?code=abc&state=xyz`;

const pending = Symbol("pending");
const settledWithin = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 20, pending))]);

describe("webAuthBrowser", () => {
  it("sends the page itself to the provider and never settles, since the page leaves", async () => {
    const assign = vi.fn();
    const api = await webAuthBrowser(() => ({ assign })).create();
    expect(await settledWithin(api.open(PAGE, "https://app.example.com/"))).toBe(pending);
    expect(assign).toHaveBeenCalledExactlyOnceWith(PAGE);
  });

  it("is available in a browser only, never in a native shell's webview", () => {
    const adapter = webAuthBrowser(() => ({ assign: vi.fn() }));
    expect(adapter.available()).toBe(true);
    globals.__TAURI_INTERNALS__ = {};
    expect(adapter.available()).toBe(false);
    delete globals.__TAURI_INTERNALS__;
    globals.Capacitor = { isNativePlatform: () => true };
    expect(adapter.available()).toBe(false);
    delete globals.Capacitor;
    expect(webAuthBrowser(() => undefined).available()).toBe(false);
  });

  it("leaves a native shell without its own adapter unable to sign in socially", async () => {
    globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
    const handle = await resolveCapability(
      {
        name: "authBrowser",
        adapters: [capacitorAuthBrowser(), webAuthBrowser(() => ({ assign: vi.fn() }))],
      },
      "capacitor",
    );
    expect(handle.available).toBe(false);
  });
});

function tauri(answer: (args: Record<string, unknown>) => unknown) {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  return {
    calls,
    load: async () => ({
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        if (command !== "parlor_auth_browser_open") throw `Command ${command} not found`;
        return answer(args ?? {}) as T;
      },
    }),
  };
}

describe("tauriAuthBrowser", () => {
  it("opens ASWebAuthenticationSession with the callback's scheme and resolves with where it returned", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const shell = tauri(() => RETURNED);
    const api = await tauriAuthBrowser(shell.load).create();
    expect(await api.open(PAGE, CALLBACK)).toBe(RETURNED);
    expect(shell.calls).toEqual([
      ["parlor_auth_browser_open", { url: PAGE, callbackScheme: "hello" }],
    ]);
  });

  it("resolves undefined when the user closes it", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const api = await tauriAuthBrowser(tauri(() => null).load).create();
    expect(await api.open(PAGE, CALLBACK)).toBeUndefined();
  });

  it("is available when the command refuses the probe's empty URL", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const shell = tauri(({ url }) => {
      if (url === "") throw 'The sign-in page must be an http(s) URL: ""';
      return RETURNED;
    });
    expect(await tauriAuthBrowser(shell.load).available()).toBe(true);
    expect(shell.calls).toEqual([
      ["parlor_auth_browser_open", { url: "", callbackScheme: "" }],
    ]);
  });

  it.each(["Command parlor_auth_browser_open not found", "unsupported"])(
    "is unavailable in a shell without a working command (%s)",
    async (failure) => {
      globals.__TAURI_INTERNALS__ = {};
      const shell = tauri(() => {
        throw failure;
      });
      expect(await tauriAuthBrowser(shell.load).available()).toBe(false);
    },
  );

  it("is unavailable outside a Tauri shell, without asking it", async () => {
    const shell = tauri(() => RETURNED);
    expect(await tauriAuthBrowser(shell.load).available()).toBe(false);
    expect(shell.calls).toEqual([]);
  });
});

describe("capacitorAuthBrowser", () => {
  const plugin = (answer: { url?: string }) => {
    const open = vi.fn(
      async (_options: { url: string; callbackScheme: string }) => answer,
    );
    return { open, load: async () => ({ ParlorAuthBrowser: { open } }) };
  };

  it("is available on iOS, where the plugin has an implementation", () => {
    const adapter = capacitorAuthBrowser(plugin({}).load);
    expect(adapter.available()).toBe(false);
    globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
    expect(adapter.available()).toBe(false);
    globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
    expect(adapter.available()).toBe(true);
  });

  it("opens ASWebAuthenticationSession with the callback's scheme and resolves with where it returned", async () => {
    globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
    const native = plugin({ url: RETURNED });
    const api = await capacitorAuthBrowser(native.load).create();
    expect(await api.open(PAGE, CALLBACK)).toBe(RETURNED);
    expect(native.open).toHaveBeenCalledExactlyOnceWith({
      url: PAGE,
      callbackScheme: "hello",
    });
  });

  it("resolves undefined when the user closes it", async () => {
    globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
    const api = await capacitorAuthBrowser(plugin({}).load).create();
    expect(await api.open(PAGE, CALLBACK)).toBeUndefined();
  });
});
