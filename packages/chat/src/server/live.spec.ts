import { asId, type Principal } from "@parlor/core";
import type { ChannelConnection } from "@parlor/sync";
import { describe, expect, it } from "vitest";

import type { HostFrame } from "../protocol.js";
import {
  inProcessRelay,
  type LiveRelay,
  MAX_OPEN_BYTES_PER_TURN,
  MAX_OPEN_TURNS,
} from "./live.js";
import type { TurnHolder } from "./store.js";

const alice = { scope: "alice", userId: asId("user", "alice") };
const bob = { scope: "bob", userId: asId("user", "bob") };

const holder = (owner = alice, threadId = "t1"): TurnHolder => ({
  owner,
  threadId: asId("thread", threadId),
  hostId: asId("host", "mac"),
});

const userPrincipal = (id: string): Principal => ({
  kind: "user",
  userId: asId("user", id),
  sessionId: `s-${id}`,
});

function connect(
  relay: LiveRelay,
  scope: string,
  principal: Principal | undefined,
  closed?: AbortSignal,
) {
  const received: unknown[] = [];
  const connection: ChannelConnection = {
    clientId: "tab",
    scope,
    principal,
    closed,
    send: (data) => received.push(JSON.parse(data)),
  };
  const detach = relay.channel.connect(connection);
  return { received, detach };
}

const delta = (itemId: string, offset: number, text: string): HostFrame => ({
  type: "delta",
  itemId: asId("item", itemId),
  kind: "reply",
  offset,
  text,
});

const batch = (turnId: string, ...frames: HostFrame[]) => ({
  turnId: asId("turn", turnId),
  frames,
});

describe("inProcessRelay", () => {
  it("carries the chat channel", () => {
    expect(inProcessRelay().channel.event).toBe("chat");
  });

  it("pushes a host's deltas to the owner's streams only, as chat frames", () => {
    const relay = inProcessRelay();
    const mine = connect(relay, "alice", userPrincipal("alice"));
    const other = connect(relay, "bob", userPrincipal("bob"));
    const sameScopeOtherUser = connect(relay, "alice", userPrincipal("carol"));
    relay.accept(holder(), batch("u1", delta("u1.1", 0, "Hel"), delta("u1.1", 3, "lo")));
    expect(mine.received).toEqual([
      {
        type: "delta",
        threadId: "t1",
        turnId: "u1",
        itemId: "u1.1",
        kind: "reply",
        offset: 0,
        text: "Hel",
      },
      {
        type: "delta",
        threadId: "t1",
        turnId: "u1",
        itemId: "u1.1",
        kind: "reply",
        offset: 3,
        text: "lo",
      },
    ]);
    expect(other.received).toEqual([]);
    expect(sameScopeOtherUser.received).toEqual([]);
  });

  it("skips a duplicate delta, trims an overlapping one and drops one after a gap", () => {
    const relay = inProcessRelay();
    const tab = connect(relay, "alice", userPrincipal("alice"));
    relay.accept(
      holder(),
      batch(
        "u1",
        delta("u1.1", 0, "Hel"),
        delta("u1.1", 0, "Hel"),
        delta("u1.1", 1, "ello"),
        delta("u1.1", 9, "gap"),
        delta("u1.1", 12, "more"),
      ),
    );
    expect(tab.received).toMatchObject([
      { offset: 0, text: "Hel" },
      { offset: 3, text: "lo" },
    ]);
    expect(relay.open(alice, asId("thread", "t1"))).toEqual([
      {
        turnId: "u1",
        threadId: "t1",
        items: [{ id: "u1.1", kind: "reply", text: "Hello" }],
      },
    ]);
  });

  it("holds a tool's latest state and a plan's, replacing rather than appending", () => {
    const relay = inProcessRelay();
    relay.accept(
      holder(),
      batch(
        "u1",
        {
          type: "item",
          item: {
            id: asId("item", "u1.2"),
            kind: "tool",
            title: "Creating",
            status: "pending",
          },
        },
        {
          type: "item",
          item: {
            id: asId("item", "u1.2"),
            kind: "tool",
            title: "Creating",
            status: "running",
          },
        },
        {
          type: "item",
          item: {
            id: asId("item", "u1.3"),
            kind: "plan",
            entries: [{ content: "Write", status: "in_progress" }],
          },
        },
      ),
    );
    expect(relay.open(alice, asId("thread", "t1"))[0]?.items).toEqual([
      { id: "u1.2", kind: "tool", title: "Creating", status: "running" },
      {
        id: "u1.3",
        kind: "plan",
        entries: [{ content: "Write", status: "in_progress" }],
      },
    ]);
  });

  it("shows open turns to their owner and thread only", () => {
    const relay = inProcessRelay();
    relay.accept(holder(alice, "t1"), batch("u1", delta("u1.1", 0, "a")));
    relay.accept(holder(alice, "t2"), batch("u2", delta("u2.1", 0, "b")));
    expect(relay.open(alice, asId("thread", "t1")).map((turn) => turn.turnId)).toEqual([
      "u1",
    ]);
    expect(relay.open(bob, asId("thread", "t1"))).toEqual([]);
  });

  it("settles a turn: forgets it, tells the owner and ignores late frames", () => {
    const relay = inProcessRelay();
    const tab = connect(relay, "alice", userPrincipal("alice"));
    relay.accept(holder(), batch("u1", delta("u1.1", 0, "Hi")));
    relay.settle(alice, asId("thread", "t1"), asId("turn", "u1"));
    relay.accept(holder(), batch("u1", delta("u1.1", 2, "!")));
    expect(tab.received.at(-1)).toEqual({
      type: "settled",
      threadId: "t1",
      turnId: "u1",
    });
    expect(tab.received).toHaveLength(2);
    expect(relay.open(alice, asId("thread", "t1"))).toEqual([]);
  });

  it("stops streaming a turn that passes its byte budget", () => {
    const relay = inProcessRelay();
    const tab = connect(relay, "alice", userPrincipal("alice"));
    const chunk = "x".repeat(MAX_OPEN_BYTES_PER_TURN / 2 - 10);
    relay.accept(holder(), batch("u1", delta("u1.1", 0, chunk)));
    relay.accept(holder(), batch("u1", delta("u1.1", chunk.length, chunk)));
    relay.accept(
      holder(),
      batch(
        "u1",
        delta("u1.1", 2 * chunk.length, chunk),
        delta("u1.1", 3 * chunk.length, "tail"),
      ),
    );
    expect(tab.received).toHaveLength(2);
    const item = relay.open(alice, asId("thread", "t1"))[0]?.items[0];
    expect(item?.kind === "reply" && item.text.length).toBe(2 * chunk.length);
  });

  it("keeps at most MAX_OPEN_TURNS turns, dropping the oldest", () => {
    const relay = inProcessRelay();
    for (let n = 0; n <= MAX_OPEN_TURNS; n += 1) {
      relay.accept(holder(alice, `t${n}`), batch(`u${n}`, delta(`u${n}.1`, 0, "x")));
    }
    expect(relay.open(alice, asId("thread", "t0"))).toEqual([]);
    expect(relay.open(alice, asId("thread", `t${MAX_OPEN_TURNS}`))).toHaveLength(1);
    expect(relay.open(alice, asId("thread", "t1"))).toHaveLength(1);
  });

  it("stops sending to a stream once it detaches or its holder's credential ends", () => {
    const relay = inProcessRelay();
    const ended = new AbortController();
    const first = connect(relay, "alice", userPrincipal("alice"), ended.signal);
    const second = connect(relay, "alice", userPrincipal("alice"));
    relay.accept(holder(), batch("u1", delta("u1.1", 0, "a")));
    ended.abort();
    second.detach();
    relay.accept(holder(), batch("u1", delta("u1.1", 1, "b")));
    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(1);
  });

  it("does not connect a stream that already ended", () => {
    const relay = inProcessRelay();
    const ended = new AbortController();
    ended.abort();
    const tab = connect(relay, "alice", userPrincipal("alice"), ended.signal);
    relay.accept(holder(), batch("u1", delta("u1.1", 0, "a")));
    expect(tab.received).toEqual([]);
  });

  it("serves the dev host's turns, owned by the default user, to an anonymous stream", () => {
    const relay = inProcessRelay();
    const dev = { scope: "default", userId: asId("user", "default") };
    const tab = connect(relay, "default", undefined);
    relay.accept(holder(dev), batch("u1", delta("u1.1", 0, "a")));
    expect(tab.received).toHaveLength(1);
  });

  it("forgets everything on close and accepts nothing after", () => {
    const relay = inProcessRelay();
    const tab = connect(relay, "alice", userPrincipal("alice"));
    relay.accept(holder(), batch("u1", delta("u1.1", 0, "a")));
    relay.close();
    relay.accept(holder(), batch("u2", delta("u2.1", 0, "b")));
    expect(tab.received).toHaveLength(1);
    expect(relay.open(alice, asId("thread", "t1"))).toEqual([]);
  });
});
