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
});
