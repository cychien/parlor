import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ConnectionScope,
  createConnectionScope,
  type NotificationBus,
} from "./connection-scope.js";
import { createDatabase, type DatabaseHandle } from "./database.js";

const postgresUrl = process.env.PARLOR_TEST_DATABASE_URL;

/** Runtimes joined the way a host's bus joins Durable Objects: each hears only its subscriptions. */
function bus() {
  const scopes = new Map<string, ConnectionScope>();
  const subscribed = new Map<string, Set<string>>();
  const log: string[] = [];
  const key = (channel: string, topic: string) => `${channel}/${topic}`;
  const join = (name: string): ConnectionScope => {
    const link: NotificationBus = {
      async publish(channel, topic, payload) {
        for (const other of subscribed.get(key(channel, topic)) ?? []) {
          if (other !== name) scopes.get(other)!.deliver(channel, topic, payload);
        }
      },
      async subscribe(channel, topic) {
        log.push(`${name} +${key(channel, topic)}`);
        const names = subscribed.get(key(channel, topic)) ?? new Set();
        names.add(name);
        subscribed.set(key(channel, topic), names);
      },
      async unsubscribe(channel, topic) {
        log.push(`${name} -${key(channel, topic)}`);
        subscribed.get(key(channel, topic))?.delete(name);
      },
    };
    const scope = createConnectionScope({ bus: link });
    scopes.set(name, scope);
    return scope;
  };
  return { join, log };
}

describe.runIf(postgresUrl)("notifications on a bus", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createDatabase({ url: postgresUrl, notifications: "bus" });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("reaches the runtimes listening to the topic once the write commits, and nothing on rollback", async () => {
    const { join } = bus();
    const listener = join("account-1");
    const other = join("account-2");
    const writer = join("worker");
    const heard: string[] = [];
    const otherHeard: string[] = [];
    await listener.run(() =>
      handle.listen("sync", (payload) => heard.push(payload), { topic: "org-1" }),
    );
    await other.run(() =>
      handle.listen("sync", (payload) => otherHeard.push(payload), { topic: "org-2" }),
    );

    await writer.run(() =>
      handle.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        await handle.notify("sync", "first", tx, "org-1");
        expect(heard).toEqual([]);
      }),
    );
    expect(heard).toEqual(["first"]);

    await expect(
      writer.run(() =>
        handle.transaction(async (tx) => {
          await handle.notify("sync", "rolled back", tx, "org-1");
          throw new Error("roll back");
        }),
      ),
    ).rejects.toThrow("roll back");
    await writer.run(() => handle.notify("sync", "no transaction", undefined, "org-1"));

    expect(heard).toEqual(["first", "no transaction"]);
    expect(otherHeard).toEqual([]);
    await Promise.all([listener.close(), other.close(), writer.close()]);
  });

  it("subscribes a topic on its first listener and leaves it with its last", async () => {
    const { join, log } = bus();
    const scope = join("account-1");
    const first = await scope.run(() =>
      handle.listen("sync", () => {}, { topic: "org-1" }),
    );
    const second = await scope.run(() =>
      handle.listen("sync", () => {}, { topic: "org-1" }),
    );
    expect(log).toEqual(["account-1 +sync/org-1"]);
    await first();
    expect(log).toEqual(["account-1 +sync/org-1"]);
    await second();
    expect(log).toEqual(["account-1 +sync/org-1", "account-1 -sync/org-1"]);
    expect(scope.deliver("sync", "org-1", "late")).toBe(false);
    await scope.close();
  });

  it("hears its own notifications without the bus sending them back", async () => {
    const { join } = bus();
    const scope = join("account-1");
    const heard: string[] = [];
    await scope.run(() => handle.listen("parlor_auth", (payload) => heard.push(payload)));
    await scope.run(() => handle.notify("parlor_auth", "revoked"));
    expect(heard).toEqual(["revoked"]);
    await scope.close();
  });
});
