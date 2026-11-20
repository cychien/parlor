import { createDatabase, type DatabaseHandle } from "@parlor/data";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { SyncEvent } from "../protocol.js";
import { SyncHub } from "./hub.js";
import { ensureSyncTables, recordSyncEvent } from "./store.js";

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

describe("a hub that hears in its own process", () => {
  let handle: DatabaseHandle;
  let reads: number;
  let failing: boolean;
  let said: (() => void) | undefined;
  let hub: SyncHub;

  beforeAll(async () => {
    handle = await createDatabase({ dataDir: "memory://" });
    await ensureSyncTables(handle.db);
  }, 30_000);
  afterAll(() => handle.close());
  beforeEach(() => {
    reads = 0;
    failing = false;
    said = undefined;
    hub = new SyncHub({
      read: () => {
        reads += 1;
        if (failing) throw new Error("the database is away");
        return handle.db;
      },
      transaction: (run) => handle.transaction(run),
      listen: async (_channel, handler) => {
        said = () => handler("whatever was notified");
        return async () => {};
      },
      notifications: "process",
    });
  });
  afterEach(() => hub.stop());

  /** Commits an event and tells nobody. */
  const write = (scope: string, id: string) =>
    handle.transaction((tx) =>
      recordSyncEvent(tx, { scope, tags: [["tasks", id]] }, async () => undefined),
    );
  const subscriber = (scope: string) => {
    const seen: SyncEvent[] = [];
    hub.subscribe(scope, (event) => seen.push(event));
    return seen;
  };

  it("says that no event can miss it", () => {
    expect(hub.lossless).toBe(true);
  });

  it("reads what was written from the log, in the order it committed, whatever the notification says", async () => {
    await hub.start();
    const acme = subscriber("acme");
    const other = subscriber("other");
    const first = await write("acme", "1");
    const second = await write("other", "2");
    const third = await write("acme", "3");

    said!();
    await vi.waitFor(() => expect(acme).toHaveLength(2));
    expect(acme).toEqual([first, third]);
    expect(other).toEqual([second]);
  });

  it("delivers an event whose notification never came with the next one", async () => {
    await hub.start();
    const acme = subscriber("acme");
    const unannounced = await write("acme", "1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acme).toEqual([]);

    const announced = await write("acme", "2");
    said!();
    await vi.waitFor(() => expect(acme).toEqual([unannounced, announced]));
  });

  it("delivers nothing twice when notifications pile up while it reads", async () => {
    await hub.start();
    const acme = subscriber("acme");
    const events = [await write("acme", "1"), await write("acme", "2")];
    said!();
    said!();
    said!();
    events.push(await write("acme", "3"));
    said!();
    await vi.waitFor(() => expect(acme).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acme).toEqual(events);
  });

  it("reads nothing for a write nobody is subscribed to, and starts the next subscriber from where the log is then", async () => {
    await hub.start();
    const leave = hub.subscribe("acme", () => undefined);
    leave();
    const before = reads;
    await write("acme", "old");
    said!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(before);

    await hub.start();
    const acme = subscriber("acme");
    const fresh = await write("acme", "new");
    said!();
    await vi.waitFor(() => expect(acme).toEqual([fresh]));
  });

  it("tries again by itself when the log cannot be read", async () => {
    const complain = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await hub.start();
      const acme = subscriber("acme");
      const event = await write("acme", "1");
      failing = true;
      said!();
      await vi.waitFor(() => expect(complain).toHaveBeenCalled());
      failing = false;
      await vi.waitFor(() => expect(acme).toEqual([event]), { timeout: 3000 });
    } finally {
      complain.mockRestore();
    }
  });
});
