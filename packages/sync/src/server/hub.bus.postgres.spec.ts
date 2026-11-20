import {
  type ConnectionScope,
  createConnectionScope,
  createDatabase,
} from "@parlor/data";
import type { DatabaseHandle, NotificationBus } from "@parlor/data";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { SyncEvent } from "../protocol.js";
import { SyncHub } from "./hub.js";
import {
  ensureSyncTables,
  recordSyncEvent,
  type SyncDatabase,
  syncNotifyOf,
} from "./store.js";

const postgresUrl = process.env.PARLOR_TEST_DATABASE_URL;

/** Durable Objects and a Worker, joined as a host's bus joins them. */
function runtimes() {
  const scopes = new Map<string, ConnectionScope>();
  const subscribed = new Map<string, Set<string>>();
  return {
    join(name: string): ConnectionScope {
      const bus: NotificationBus = {
        async publish(channel, topic, payload) {
          for (const other of subscribed.get(topic) ?? []) {
            if (other !== name) scopes.get(other)!.deliver(channel, topic, payload);
          }
        },
        async subscribe(_channel, topic) {
          const names = subscribed.get(topic) ?? new Set();
          names.add(name);
          subscribed.set(topic, names);
        },
        async unsubscribe(_channel, topic) {
          subscribed.get(topic)?.delete(name);
        },
      };
      const scope = createConnectionScope({ bus });
      scopes.set(name, scope);
      return scope;
    },
  };
}

describe.runIf(postgresUrl)("a sync hub on a bus", () => {
  let data: DatabaseHandle;
  const run = crypto.randomUUID();
  const org = (n: number) => `org-${n}-${run}`;

  beforeAll(async () => {
    data = await createDatabase({ url: postgresUrl, notifications: "bus" });
    await ensureSyncTables(data.db as SyncDatabase);
  }, 30_000);

  afterAll(async () => {
    await data?.close();
  });

  it("hears the streams it serves when another runtime writes them, and only those", async () => {
    const { join } = runtimes();
    const ada = join("account-ada");
    const bob = join("account-bob");
    const worker = join("worker");
    const adaHub = new SyncHub(data);
    const bobHub = new SyncHub(data);
    await ada.run(() => adaHub.start());
    await bob.run(() => bobHub.start());
    expect(adaHub.lossless).toBe(true);

    const adaHeard: SyncEvent[] = [];
    const bobHeard: SyncEvent[] = [];
    ada.run(() => adaHub.subscribe(org(1), (event) => adaHeard.push(event)));
    bob.run(() => bobHub.subscribe(org(2), (event) => bobHeard.push(event)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const write = (scope: string, table: string) =>
      worker.run(() =>
        data.transaction((tx) =>
          recordSyncEvent(
            tx as SyncDatabase,
            { scope, tags: [[table]] },
            syncNotifyOf(data),
          ),
        ),
      );
    await write(org(1), "notes");
    await write(org(3), "nobody");
    await write(org(2), "tasks");

    await vi.waitFor(() =>
      expect(adaHeard.map((event) => event.tags)).toEqual([[["notes"]]]),
    );
    await vi.waitFor(() =>
      expect(bobHeard.map((event) => event.tags)).toEqual([[["tasks"]]]),
    );

    await ada.run(() => adaHub.stop());
    await bob.run(() => bobHub.stop());
    await Promise.all([ada.close(), bob.close(), worker.close()]);
  });
});
