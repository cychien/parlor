import { describe, expect, it } from "vitest";

import type { PresenceUpdate } from "../protocol.js";
import { ClientDirectory } from "./directory.js";

function setup() {
  let now = 1000;
  const directory = new ClientDirectory(() => now);
  const sent: string[] = [];
  const connect = (clientId: string | undefined, scope = "default") =>
    directory.connect({
      clientId,
      scope,
      send: (data) => sent.push(`${clientId}:${data}`),
    });
  const presence = (
    focused: boolean,
    visible: boolean,
    platform = "web",
  ): PresenceUpdate => ({
    type: "presence",
    focused,
    visible,
    platform,
  });
  const join = (clientId: string, scope = "default") => {
    const close = connect(clientId, scope);
    directory.presence(clientId, scope, presence(false, false));
    return close;
  };
  return {
    directory,
    sent,
    connect,
    join,
    presence,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const pick = (directory: ClientDirectory, scope = "default", clientId?: string) => {
  const selection = directory.select(scope, clientId);
  return (
    selection && {
      id: selection.target.client.id,
      tied: selection.tied.map((c) => c.id),
    }
  );
};

describe("ClientDirectory selection", () => {
  it("selects nothing in an empty scope and ignores connections without a client id", () => {
    const { directory, connect } = setup();
    connect(undefined);
    expect(directory.select("default")).toBeUndefined();
  });

  it("prefers an explicit client id connected in the same scope", () => {
    const { directory, join, presence, tick } = setup();
    join("a");
    join("b");
    join("other", "elsewhere");
    tick(10);
    directory.presence("b", "default", presence(true, true));
    expect(pick(directory, "default", "a")).toEqual({ id: "a", tied: [] });
    expect(pick(directory, "default", "other")).toEqual({ id: "b", tied: [] });
  });

  it("picks the focused client over more recently seen ones", () => {
    const { directory, connect, presence, tick } = setup();
    connect("a");
    connect("b");
    directory.presence("a", "default", presence(true, true));
    tick(10);
    directory.presence("b", "default", presence(false, true));
    expect(pick(directory)).toEqual({ id: "a", tied: [] });
  });

  it("reports a tie when several clients are focused", () => {
    const { directory, connect, presence, tick } = setup();
    connect("desk");
    connect("phone");
    directory.presence("desk", "default", presence(true, true));
    tick(10);
    directory.presence("phone", "default", presence(true, true, "capacitor"));
    expect(pick(directory)).toEqual({ id: "phone", tied: ["desk"] });
  });

  it("falls back to the visible client seen most recently, then the most recently seen", () => {
    const { directory, connect, presence, tick } = setup();
    connect("a");
    connect("b");
    connect("c");
    directory.presence("a", "default", presence(false, true));
    tick(10);
    directory.presence("b", "default", presence(false, false));
    expect(pick(directory)).toEqual({ id: "a", tied: [] });
    tick(10);
    directory.presence("a", "default", presence(false, false));
    tick(10);
    directory.presence("c", "default", presence(false, false));
    expect(pick(directory)).toEqual({ id: "c", tied: [] });
  });

  it("counts an action call from a client as being seen", () => {
    const { directory, connect, presence, tick } = setup();
    connect("a");
    connect("b");
    directory.presence("a", "default", presence(false, false));
    tick(10);
    directory.presence("b", "default", presence(false, false));
    tick(10);
    directory.touch("a");
    directory.touch("unknown");
    expect(pick(directory)).toEqual({ id: "a", tied: [] });
  });

  it("reports a tie between visible clients seen at the same moment", () => {
    const { directory, connect, presence } = setup();
    connect("a");
    connect("b");
    directory.presence("a", "default", presence(false, true));
    directory.presence("b", "default", presence(false, true));
    expect(pick(directory)).toEqual({ id: "b", tied: ["a"] });
  });

  it("rejects presence from unknown clients or another scope", () => {
    const { directory, connect, presence } = setup();
    connect("a");
    expect(directory.presence("a", "default", presence(true, true))).toBe("registered");
    expect(directory.presence("a", "default", presence(false, true))).toBe("updated");
    expect(directory.presence("a", "elsewhere", presence(true, true))).toBe("rejected");
    expect(directory.presence("zz", "default", presence(true, true))).toBe("rejected");
  });
});

describe("ClientDirectory registration", () => {
  it("never lists, selects or targets a client whose stream opened without announcing agent UI", () => {
    const { directory, connect, join, sent, tick } = setup();
    join("new-tab");
    connect("old-build");
    tick(10);
    directory.touch("old-build");
    expect(pick(directory)).toEqual({ id: "new-tab", tied: [] });
    expect(pick(directory, "default", "old-build")).toEqual({ id: "new-tab", tied: [] });
    expect(directory.summaries("default").map((c) => c.id)).toEqual(["new-tab"]);
    expect(directory.connected("default", "old-build")).toBe(false);
    expect(directory.target("old-build")).toBeUndefined();
    expect(directory.leave("old-build", "default")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("selects nothing when the only open stream never announced agent UI", () => {
    const { directory, connect } = setup();
    connect("old-build");
    directory.touch("old-build");
    expect(directory.select("default")).toBeUndefined();
    expect(directory.summaries("default")).toEqual([]);
  });

  it("keeps sending on the announced connection until the client announces on a newer one", () => {
    const { directory, presence } = setup();
    const oldSent: string[] = [];
    const newSent: string[] = [];
    directory.connect({ clientId: "a", scope: "default", send: (d) => oldSent.push(d) });
    directory.presence("a", "default", presence(true, true));
    directory.connect({ clientId: "a", scope: "default", send: (d) => newSent.push(d) });
    directory.target("a")?.send("before");
    expect(directory.presence("a", "default", presence(true, true))).toBe("registered");
    directory.target("a")?.send("after");
    expect(oldSent).toEqual(["before"]);
    expect(newSent).toEqual(["after"]);
  });

  it("moves a client to the scope it announces from and stops using its old connections", () => {
    const { directory, presence } = setup();
    const oldSent: string[] = [];
    const newSent: string[] = [];
    const closeOld = directory.connect({
      clientId: "a",
      scope: "alice",
      send: (d) => oldSent.push(d),
    });
    directory.presence("a", "alice", presence(true, true));
    directory.connect({ clientId: "a", scope: "bob", send: (d) => newSent.push(d) });
    expect(directory.presence("a", "bob", presence(true, true))).toBe("registered");
    closeOld();
    expect(directory.summaries("alice")).toEqual([]);
    expect(directory.connected("bob", "a")).toBe(true);
    directory.target("a")?.send("x");
    expect(oldSent).toEqual([]);
    expect(newSent).toEqual(["x"]);
  });

  it("drops an unannounced connection that closes before its client announces", () => {
    const { directory, connect, presence } = setup();
    const close = connect("a");
    close();
    expect(directory.presence("a", "default", presence(true, true))).toBe("rejected");
    expect(directory.select("default")).toBeUndefined();
  });
});

describe("ClientDirectory connections", () => {
  it("sends on the newest connection and survives a late close of the old one", () => {
    const { directory, sent, presence } = setup();
    const oldSent: string[] = [];
    const closeOld = directory.connect({
      clientId: "a",
      scope: "default",
      send: (data) => oldSent.push(data),
    });
    const closeNew = directory.connect({
      clientId: "a",
      scope: "default",
      send: (data) => sent.push(data),
    });
    directory.presence("a", "default", presence(true, true));
    closeOld();
    closeOld();
    expect(directory.target("a")?.send("x")).toBe(true);
    expect(sent).toEqual(["x"]);
    expect(oldSent).toEqual([]);
    closeNew();
    expect(directory.select("default")).toBeUndefined();
    expect(directory.target("a")).toBeUndefined();
  });

  it("forgets a client that announced it is leaving, before its stream closes", () => {
    const { directory, connect, join, presence } = setup();
    const close = connect("a");
    join("b");
    directory.presence("a", "default", presence(true, true));
    expect(directory.leave("a", "elsewhere")).toBe(false);
    expect(directory.leave("a", "default")).toBe(true);
    expect(directory.leave("a", "default")).toBe(false);
    expect(directory.summaries("default").map((c) => c.id)).toEqual(["b"]);
    expect(pick(directory)).toEqual({ id: "b", tied: [] });
    close();
    expect(directory.summaries("default").map((c) => c.id)).toEqual(["b"]);
  });

  it("tells whether a client is connected in a scope once it announced agent UI", () => {
    const { directory, connect, presence } = setup();
    connect("a");
    expect(directory.connected("default", "a")).toBe(false);
    directory.presence("a", "default", presence(false, false));
    expect(directory.connected("default", "a")).toBe(true);
    expect(directory.connected("elsewhere", "a")).toBe(false);
    expect(directory.connected("default", "ghost")).toBe(false);
  });

  it("summarizes clients with platform, presence and how long ago they were seen", () => {
    const { directory, connect, presence, tick } = setup();
    connect("a");
    directory.presence("a", "default", {
      ...presence(true, true, "tauri"),
      buildId: "b1",
    });
    tick(250);
    expect(directory.summaries("default")).toEqual([
      {
        id: "a",
        platform: "tauri",
        buildId: "b1",
        focused: true,
        visible: true,
        seenAgoMs: 250,
      },
    ]);
  });

  it("forgets a client once its last announced connection closes", () => {
    const { directory, connect, presence } = setup();
    const close = connect("a");
    directory.presence("a", "default", presence(true, true));
    close();
    expect(directory.summaries("default")).toEqual([]);
    expect(directory.presence("a", "default", presence(true, true))).toBe("rejected");
  });
});
