import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { H3 } from "h3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ServerChannel } from "../channel.js";
import { createSyncClient } from "../client/sync-client.js";
import { SyncHub } from "./hub.js";
import { registerSyncRoutes } from "./routes.js";
import { ensureSyncTables } from "./store.js";

let handle: DatabaseHandle;
let hub: SyncHub;

beforeAll(async () => {
  handle = await createDatabase({ dataDir: "memory://" });
  await ensureSyncTables(handle.db);
  hub = new SyncHub(handle);
}, 30_000);
afterAll(async () => {
  await hub.stop();
  await handle.close();
});

describe("regression-guard: a client that never asks for a plugin channel", () => {
  it("keeps receiving its own channel and silently drops the plugin channel's frames", async () => {
    const senders: Record<string, (data: string) => void> = {};
    const channelNamed = (event: string): ServerChannel => ({
      event,
      connect(connection) {
        senders[event] = connection.send;
        connection.send(`${event}-hello`);
        return () => {};
      },
    });
    const server = new H3();
    registerSyncRoutes(server, {
      basePath: "/_parlor",
      data: handle,
      hub,
      scope: () => "old-client",
      keepAliveMs: 50,
      channels: [channelNamed("ui"), channelNamed("chat")],
    });

    const received: string[] = [];
    const onError = vi.fn();
    const client = createSyncClient({
      request: (path, init) => server.fetch(new Request(`http://app.test${path}`, init)),
      onEvents: () => {},
      onError,
      channels: [
        {
          event: "ui",
          opened: () => {},
          receive: (data) => received.push(data),
          closed: () => {},
        },
      ],
    });
    client.start();
    await vi.waitFor(() => expect(received).toEqual(["ui-hello"]));
    senders.chat!("chat-delta");
    senders.ui!("ui-second");
    await vi.waitFor(() => expect(received).toEqual(["ui-hello", "ui-second"]));

    expect(onError).not.toHaveBeenCalled();
    client.stop();
  });
});
