import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiBroker, UiFailure } from "./broker.js";
import type { ConnectedClient } from "./directory.js";

const client = (id: string): ConnectedClient => ({
  id,
  scope: "default",
  platform: "web",
  buildId: undefined,
  focused: true,
  visible: true,
  seenAt: 0,
});

function target(id: string, connected = true) {
  const frames: string[] = [];
  let online = connected;
  return {
    frames,
    setOnline: (value: boolean) => {
      online = value;
    },
    target: {
      client: client(id),
      send: (data: string) => {
        if (!online) return false;
        frames.push(data);
        return true;
      },
    },
  };
}

const origin = { via: "mcp" } as const;
const screen = { route: null, queries: [], views: {}, attention: {}, truncated: false };

function brokerWith(options: Partial<ConstructorParameters<typeof UiBroker>[0]> = {}) {
  let n = 0;
  return new UiBroker({ timeoutMs: 1000, newId: () => `r${++n}`, ...options });
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UiFailure) return error.error;
    throw error;
  }
  throw new Error("expected a UiFailure");
}

describe("UiBroker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a request frame to the target and resolves with the reply from that client", async () => {
    const broker = brokerWith();
    const tab = target("a");
    const result = broker.request(tab.target, "screen", {}, origin);
    expect(tab.frames.map((f) => JSON.parse(f))).toEqual([
      { id: "r1", op: "screen", input: {}, origin: { via: "mcp" }, timeoutMs: 1000 },
    ]);
    expect(
      broker.reply("a", { type: "reply", id: "r1", ok: true, result: screen }),
    ).toEqual({ accepted: true, next: undefined });
    await expect(result).resolves.toEqual(screen);
  });

  it("accepts a reply only from the target client and only once", async () => {
    const broker = brokerWith();
    const result = broker.request(target("a").target, "screen", {}, origin);
    const reply = { type: "reply", id: "r1", ok: true, result: screen } as const;
    expect(broker.reply("b", reply)).toEqual({ accepted: false });
    expect(broker.reply("a", reply)).toEqual({ accepted: true, next: undefined });
    expect(broker.reply("a", reply)).toEqual({ accepted: false });
    expect(broker.reply("a", { ...reply, id: "nope" })).toEqual({ accepted: false });
    await expect(result).resolves.toEqual(screen);
  });

  it("rejects with the client's error", async () => {
    const broker = brokerWith();
    const result = broker.request(target("a").target, "screen", {}, origin);
    broker.reply("a", {
      type: "reply",
      id: "r1",
      ok: false,
      error: { code: "internal", message: "boom" },
    });
    await expect(failure(result)).resolves.toEqual({ code: "internal", message: "boom" });
  });

  it("times out a read that reached the client as timeout, since nothing changed", async () => {
    const broker = brokerWith();
    const result = failure(broker.request(target("a").target, "screen", {}, origin));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({
      code: "timeout",
      message:
        "The app did not answer within 1000 ms. Nothing on screen changed; retrying is safe.",
    });
    expect(
      broker.reply("a", { type: "reply", id: "r1", ok: true, result: screen }),
    ).toEqual({ accepted: false });
  });

  it("times out as timeout when the request never reached the client", async () => {
    const broker = brokerWith();
    const result = failure(
      broker.request(target("a", false).target, "screen", {}, origin),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ code: "timeout" });
  });

  it("keeps one request in flight per client and hands the next one back with the reply", async () => {
    const broker = brokerWith();
    const a = target("a");
    const b = target("b");
    const first = broker.request(a.target, "screen", {}, origin);
    const second = broker.request(a.target, "screen", {}, origin);
    const third = broker.request(a.target, "screen", {}, origin);
    const other = broker.request(b.target, "screen", {}, origin);
    expect(a.frames.map((f) => JSON.parse(f).id)).toEqual(["r1"]);
    expect(b.frames.map((f) => JSON.parse(f).id)).toEqual(["r4"]);
    expect(
      broker.reply("a", { type: "reply", id: "r1", ok: true, result: screen }),
    ).toEqual({
      accepted: true,
      next: '{"id":"r2","op":"screen","input":{},"origin":{"via":"mcp"},"timeoutMs":1000}',
    });
    expect(
      broker.reply("a", { type: "reply", id: "r2", ok: true, result: screen }),
    ).toEqual({
      accepted: true,
      next: '{"id":"r3","op":"screen","input":{},"origin":{"via":"mcp"},"timeoutMs":1000}',
    });
    expect(
      broker.reply("a", { type: "reply", id: "r3", ok: true, result: screen }),
    ).toEqual({ accepted: true, next: undefined });
    expect(
      broker.reply("b", { type: "reply", id: "r4", ok: true, result: screen }),
    ).toEqual({ accepted: true, next: undefined });
    expect(a.frames).toHaveLength(1);
    await expect(Promise.all([first, second, third, other])).resolves.toEqual([
      screen,
      screen,
      screen,
      screen,
    ]);
  });

  it("sends the next request over the stream when the one in flight gives up", async () => {
    const broker = brokerWith();
    const a = target("a");
    const controller = new AbortController();
    const first = failure(
      broker.request(a.target, "screen", {}, origin, controller.signal),
    );
    const second = broker.request(a.target, "screen", {}, origin);
    controller.abort();
    await expect(first).resolves.toMatchObject({ code: "timeout" });
    expect(a.frames.map((f) => JSON.parse(f).id)).toEqual(["r1", "r2"]);
    broker.reply("a", { type: "reply", id: "r2", ok: true, result: screen });
    await expect(second).resolves.toEqual(screen);
  });

  it("reports a request still waiting its turn at the deadline as never received", async () => {
    const broker = brokerWith();
    const a = target("a");
    const first = failure(broker.request(a.target, "screen", {}, origin));
    const second = failure(broker.request(a.target, "screen", {}, origin));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toMatchObject({ code: "timeout" });
    await expect(second).resolves.toEqual({
      code: "timeout",
      message: "The app did not answer within 1000 ms. The app did not receive it.",
    });
    expect(a.frames).toHaveLength(1);
  });

  it("re-sends pending requests when the client reconnects", async () => {
    const broker = brokerWith();
    const tab = target("a", false);
    const result = broker.request(tab.target, "screen", {}, origin);
    tab.setOnline(true);
    broker.reconnected(tab.target);
    broker.reconnected(target("b").target);
    expect(tab.frames).toHaveLength(1);
    broker.reply("a", { type: "reply", id: "r1", ok: true, result: screen });
    await expect(result).resolves.toEqual(screen);
  });

  it("refuses new requests with busy beyond the per-client and process bounds", async () => {
    const broker = brokerWith({ maxPendingPerClient: 2, maxPending: 3 });
    const a = target("a").target;
    void broker.request(a, "screen", {}, origin).catch(() => {});
    void broker.request(a, "screen", {}, origin).catch(() => {});
    await expect(failure(broker.request(a, "screen", {}, origin))).resolves.toMatchObject(
      {
        code: "busy",
      },
    );
    void broker.request(target("b").target, "screen", {}, origin).catch(() => {});
    await expect(
      failure(broker.request(target("c").target, "screen", {}, origin)),
    ).resolves.toMatchObject({ code: "busy" });
    broker.reply("a", { type: "reply", id: "r1", ok: true, result: screen });
    void broker.request(a, "screen", {}, origin).catch(() => {});
    expect(
      broker.reply("a", { type: "reply", id: "r2", ok: true, result: screen }),
    ).toEqual({
      accepted: true,
      next: '{"id":"r4","op":"screen","input":{},"origin":{"via":"mcp"},"timeoutMs":1000}',
    });
    expect(
      broker.reply("a", { type: "reply", id: "r4", ok: true, result: screen }),
    ).toEqual({ accepted: true, next: undefined });
    broker.close();
  });

  it("fails a client's pending requests at once when it leaves", async () => {
    const broker = brokerWith();
    const result = failure(broker.request(target("a").target, "screen", {}, origin));
    const other = broker.request(target("b").target, "screen", {}, origin);
    broker.abandon("a");
    await expect(result).resolves.toEqual({
      code: "timeout",
      message:
        "The app client closed before it answered. Nothing on screen changed; retrying is safe.",
    });
    expect(
      broker.reply("b", { type: "reply", id: "r2", ok: true, result: screen }),
    ).toEqual({ accepted: true, next: undefined });
    await expect(other).resolves.toEqual(screen);
  });

  it("gives up on an aborted request", async () => {
    const broker = brokerWith();
    const controller = new AbortController();
    const result = failure(
      broker.request(target("a").target, "screen", {}, origin, controller.signal),
    );
    controller.abort();
    await expect(result).resolves.toMatchObject({ code: "timeout" });
  });
});
