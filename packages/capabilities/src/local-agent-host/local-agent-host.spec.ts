import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCapability } from "../capability.js";
import type { TauriInvoke } from "../device-key/tauri.js";
import { capacitorLocalAgentHost } from "./capacitor.js";
import { localAgentHost } from "./index.js";
import type { HostPairing, PairingDevice } from "./interface.js";
import { tauriLocalAgentHost } from "./tauri.js";
import { webLocalAgentHost } from "./web.js";

const globals = globalThis as { __TAURI_INTERNALS__?: unknown };
afterEach(() => {
  delete globals.__TAURI_INTERNALS__;
});

const pairing: HostPairing = {
  hostName: "Alice's Mac",
  platform: "macos",
  codeChallenge: "challenge",
  state: "state",
  matchingCode: "ABC-DEF",
  keyThumbprint: "thumbprint",
};

const device: PairingDevice = {
  deviceId: "device-1",
  name: "Hello on macOS",
  platform: "tauri",
  signingKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
};

function shell(replies: Record<string, unknown>) {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    void args;
    if (!(command in replies)) throw new Error(`Command ${command} not found`);
    const reply = replies[command];
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { invoke, load: async () => ({ invoke }) as unknown as TauriInvoke };
}

describe("webLocalAgentHost and capacitorLocalAgentHost", () => {
  it("are never available: a page and a phone cannot reach a host process", async () => {
    expect(webLocalAgentHost().available()).toBe(false);
    expect(capacitorLocalAgentHost().available()).toBe(false);
    expect(() => webLocalAgentHost().create()).toThrow(/not reachable from a web page/);
    expect(() => capacitorLocalAgentHost().create()).toThrow(/cannot run on a phone/);
    expect((await resolveCapability(localAgentHost, "web")).available).toBe(false);
  });
});

describe("tauriLocalAgentHost", () => {
  it("is available only in a Tauri shell built with the bundled host", async () => {
    expect(
      await tauriLocalAgentHost(shell({ parlor_host_bundled: true }).load).available(),
    ).toBe(false);
    globals.__TAURI_INTERNALS__ = {};
    expect(
      await tauriLocalAgentHost(shell({ parlor_host_bundled: true }).load).available(),
    ).toBe(true);
    expect(
      await tauriLocalAgentHost(shell({ parlor_host_bundled: false }).load).available(),
    ).toBe(false);
    expect(await tauriLocalAgentHost(shell({}).load).available()).toBe(false);
  });

  it("reports the status the command returns", async () => {
    const running = { state: "running", version: "1.2.3", apps: ["https://hello.app"] };
    const host = await tauriLocalAgentHost(
      shell({ parlor_host_status: running }).load,
    ).create();
    expect(await host.status()).toEqual(running);
  });

  it("begins, lets the page authorize with its own session, then finishes with the code and device", async () => {
    const { invoke, load } = shell({
      parlor_host_begin: pairing,
      parlor_host_finish: { connected: true },
    });
    const authorize = vi.fn(async () => "the-code");
    const host = await tauriLocalAgentHost(load).create();
    expect(
      await host.connect({ appOrigin: "https://hello.app", authorize, device }),
    ).toEqual({
      connected: true,
    });
    expect(authorize).toHaveBeenCalledWith(pairing);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "parlor_host_begin",
      "parlor_host_finish",
    ]);
    expect(invoke).toHaveBeenNthCalledWith(1, "parlor_host_begin", {
      appOrigin: "https://hello.app",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "parlor_host_finish", {
      appOrigin: "https://hello.app",
      code: "the-code",
      device,
    });
  });

  it("passes no device when the app has none, and relays a local decline", async () => {
    const { invoke, load } = shell({
      parlor_host_begin: pairing,
      parlor_host_finish: { connected: false, reason: "declined_locally" },
    });
    const host = await tauriLocalAgentHost(load).create();
    expect(
      await host.connect({ appOrigin: "https://hello.app", authorize: async () => "c" }),
    ).toEqual({ connected: false, reason: "declined_locally" });
    expect(invoke).toHaveBeenLastCalledWith("parlor_host_finish", {
      appOrigin: "https://hello.app",
      code: "c",
      device: null,
    });
  });

  it("never finishes a pairing the page could not authorize", async () => {
    const { invoke, load } = shell({ parlor_host_begin: pairing });
    const host = await tauriLocalAgentHost(load).create();
    await expect(
      host.connect({
        appOrigin: "https://hello.app",
        authorize: async () => {
          throw new Error("not signed in");
        },
      }),
    ).rejects.toThrow("not signed in");
    expect(invoke).toHaveBeenCalledOnce();
  });
});
