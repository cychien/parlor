import { createRegistry } from "@parlor/core/registry";
import type { PluginHost } from "@parlor/server";
import { createServer } from "@parlor/server";
import { describe, expect, it } from "vitest";

import { chat, DEFAULT_LEASE_MS, MAX_LEASE_MS } from "./index.js";
import { testAuth } from "./spec-kit.js";

const database = {
  read: () => undefined,
  transaction: () => Promise.reject(new Error("unused")),
};

const hostWith = (overrides: Partial<PluginHost> = {}): PluginHost => ({
  basePath: "/_parlor",
  database,
  auth: testAuth(),
  callerOf: () => Promise.reject(new Error("unused")),
  announce: () => Promise.resolve(),
  ...overrides,
});

describe("chat() setup", () => {
  it("keeps the default lease inside the revocation horizon", () => {
    expect(DEFAULT_LEASE_MS).toBe(60_000);
    expect(MAX_LEASE_MS).toBe(11 * 60_000);
  });

  it("refuses a lease above the 11-minute revocation horizon", () => {
    expect(() => chat({ leaseMs: 15 * 60_000 }).setup(hostWith())).toThrow(
      "chat(): leaseMs 900000 is above 660000, the longest a revoked computer's turn token can be kept out.",
    );
  });

  it("refuses a lease one millisecond above the horizon and accepts the horizon itself", () => {
    expect(() => chat({ leaseMs: 11 * 60_000 + 1 }).setup(hostWith())).toThrow(
      "is above 660000",
    );
    const runtime = chat({ leaseMs: 11 * 60_000 }).setup(hostWith());
    expect(runtime.actions?.names()).toContain("hostClaim");
    runtime.close?.();
  });

  it.each([0, -5, 1.5, Number.NaN])("refuses a lease of %s", (leaseMs) => {
    expect(() => chat({ leaseMs }).setup(hostWith())).toThrow(
      `chat(): leaseMs must be a positive whole number, got ${leaseMs}.`,
    );
  });

  it("refuses a queue length that is not a positive whole number", () => {
    expect(() => chat({ maxQueued: 0 }).setup(hostWith())).toThrow(
      "chat(): maxQueued must be a positive whole number, got 0.",
    );
  });

  it("refuses to start without an auth provider that mints turn tokens", () => {
    const message =
      "chat() needs an auth provider that can mint turn tokens; add `auth` to createServer (parlor dev installs one).";
    expect(() => chat().setup(hostWith({ auth: undefined }))).toThrow(message);
    const { delegate: _delegate, ...withoutDelegate } = testAuth();
    expect(() => chat().setup(hostWith({ auth: withoutDelegate }))).toThrow(message);
  });

  it("refuses to start without a database", () => {
    expect(() => chat().setup(hostWith({ database: undefined }))).toThrow(
      "chat() needs a database.",
    );
  });

  it("offers the actions, the two host routes, the chat channel and a close", () => {
    const runtime = chat().setup(hostWith());
    expect(runtime.actions?.names()).toEqual([
      "open",
      "items",
      "hosts",
      "send",
      "answer",
      "cancel",
      "hostHello",
      "hostReport",
      "hostClaim",
      "hostSignals",
      "hostAppend",
      "hostFinish",
    ]);
    expect(
      runtime.routes?.map((route) => [route.method, route.path, route.access]),
    ).toEqual([
      ["POST", "/stream", ["host"]],
      ["POST", "/heartbeat", ["host"]],
    ]);
    expect(runtime.channel?.event).toBe("chat");
    runtime.close?.();
  });

  it("stops a server from starting when installed with a lease past the horizon", () => {
    expect(() =>
      createServer({
        actions: createRegistry({}),
        auth: testAuth(),
        database,
        plugins: [chat({ leaseMs: 15 * 60_000 })],
      }),
    ).toThrow("is above 660000");
  });
});
