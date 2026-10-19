import { describe, expect, it, vi } from "vitest";

import { SyncHub } from "./hub.js";

describe("SyncHub", () => {
  it("fans NOTIFY payloads out to subscribers of the matching scope only", async () => {
    let onPayload: ((payload: string) => void) | undefined;
    const unlisten = vi.fn(async () => {});
    const hub = new SyncHub({
      read: () => ({}),
      transaction: async (run) => run({}),
      listen: async (_channel, handler) => {
        onPayload = handler;
        return unlisten;
      },
    });
    expect(hub.canPush).toBe(true);
    await hub.start();
    await hub.start();

    const acme = vi.fn();
    const other = vi.fn();
    const stop = hub.subscribe("acme", acme);
    hub.subscribe("other", other);
    const event = { version: 1, id: "a", tags: [["tasks"]] };
    onPayload?.(JSON.stringify({ scope: "acme", event }));
    onPayload?.("not json");
    expect(acme).toHaveBeenCalledWith(event);
    expect(other).not.toHaveBeenCalled();

    stop();
    expect(hub.subscriberCount("acme")).toBe(0);
    await hub.stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("reports when the provider cannot push", () => {
    const hub = new SyncHub({ read: () => ({}), transaction: async (run) => run({}) });
    expect(hub.canPush).toBe(false);
  });

  it("tells subscribers to end when it stops", async () => {
    const hub = new SyncHub({ read: () => ({}), transaction: async (run) => run({}) });
    const onStop = vi.fn();
    hub.subscribe("acme", vi.fn(), onStop);
    hub.subscribe("other", vi.fn());

    await hub.stop();

    expect(onStop).toHaveBeenCalledOnce();
    expect(hub.subscriberCount()).toBe(0);
  });

  it("ends every stream and listens again after its connection is lost", async () => {
    const listens: { onLost: (() => void) | undefined }[] = [];
    const hub = new SyncHub({
      read: () => ({}),
      transaction: async (run) => run({}),
      listen: async (_channel, _handler, options) => {
        listens.push({ onLost: options?.onLost });
        return async () => {};
      },
    });
    await hub.start();
    const onStop = vi.fn();
    hub.subscribe("acme", vi.fn(), onStop);

    listens[0]?.onLost?.();
    expect(onStop).toHaveBeenCalledOnce();

    await hub.start();
    expect(listens).toHaveLength(2);
  });

  it("tries to listen again after a failed start", async () => {
    let attempts = 0;
    const hub = new SyncHub({
      read: () => ({}),
      transaction: async (run) => run({}),
      listen: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database down");
        return async () => {};
      },
    });
    await expect(hub.start()).rejects.toThrow("database down");
    await hub.start();
    expect(attempts).toBe(2);
  });
});
