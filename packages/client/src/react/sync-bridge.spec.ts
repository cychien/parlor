import type { ClientChannel, SyncEvent } from "@parlor/sync";
import type { SyncClient } from "@parlor/sync/client";
import { describe, expect, it } from "vitest";

import { SyncBridge } from "./sync-bridge.js";

function fakeSyncClient() {
  const log: string[] = [];
  const client: SyncClient = {
    start: () => {},
    stop: () => {},
    cursor: "",
    transport: undefined,
    reconnectNow: () => {},
    addChannel(channel) {
      log.push(`add ${channel.event}`);
      return () => log.push(`detach ${channel.event}`);
    },
  };
  return { client, log };
}

const channel = (event: string): ClientChannel => ({
  event,
  opened: () => {},
  receive: () => {},
  closed: () => {},
});

const event = (id: string): SyncEvent => ({
  version: 1,
  id,
  tags: [["parlor_chat", id]],
});

describe("SyncBridge", () => {
  it("hands a channel added before the sync client exists to the client that attaches", () => {
    const bridge = new SyncBridge();
    const { client, log } = fakeSyncClient();
    bridge.addChannel(channel("chat"));
    bridge.attach(client);
    expect(log).toEqual(["add chat"]);
  });

  it("adds a channel straight to the live client and detaches it on request", () => {
    const bridge = new SyncBridge();
    const { client, log } = fakeSyncClient();
    bridge.attach(client);
    const remove = bridge.addChannel(channel("chat"));
    remove();
    expect(log).toEqual(["add chat", "detach chat"]);
  });

  it("hands every channel to the next client after the signed-in user changes", () => {
    const bridge = new SyncBridge();
    const first = fakeSyncClient();
    const second = fakeSyncClient();
    bridge.addChannel(channel("chat"));
    const release = bridge.attach(first.client);
    release();
    bridge.attach(second.client);
    expect(first.log).toEqual(["add chat"]);
    expect(second.log).toEqual(["add chat"]);
  });

  it("does not hand a removed channel to a later client", () => {
    const bridge = new SyncBridge();
    const { client, log } = fakeSyncClient();
    bridge.addChannel(channel("chat"))();
    bridge.attach(client);
    expect(log).toEqual([]);
  });

  it("delivers sync events to every listener until it unsubscribes", () => {
    const bridge = new SyncBridge();
    const seen: string[] = [];
    const off = bridge.onEvents((events) => seen.push(`a:${events.map((e) => e.id)}`));
    bridge.onEvents((events) => seen.push(`b:${events.map((e) => e.id)}`));
    bridge.emit([event("1"), event("2")]);
    off();
    bridge.emit([event("3")]);
    expect(seen).toEqual(["a:1,2", "b:1,2", "b:3"]);
  });

  it("tells every resume listener until it unsubscribes", () => {
    const bridge = new SyncBridge();
    const seen: string[] = [];
    const off = bridge.onResume(() => seen.push("a"));
    bridge.onResume(() => seen.push("b"));
    bridge.resumed();
    off();
    bridge.resumed();
    expect(seen).toEqual(["a", "b", "b"]);
  });

  it("reports the negotiated transport only while a client is attached", () => {
    const bridge = new SyncBridge();
    expect(bridge.transport()).toBeUndefined();
    const release = bridge.attach(fakeSyncClient().client);
    bridge.negotiated("poll");
    expect(bridge.transport()).toBe("poll");
    release();
    expect(bridge.transport()).toBeUndefined();
  });
});
