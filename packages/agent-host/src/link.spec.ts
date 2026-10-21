import { CHAT_ACTIVITY_TAG, CHAT_TAG, HOST_PROTOCOL } from "@parlor/chat";
import { asId } from "@parlor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AppGrant, devHostKeys } from "./grants.js";
import { type AppLinkDeps, createAppLink } from "./link.js";

const ORIGIN = "http://localhost:5301";
const turnId = asId("turn", "u1");

const grant: AppGrant = {
  appOrigin: ORIGIN,
  appName: "Hello",
  grantId: asId("grant", "host:g1"),
  hostId: asId("host", "h1"),
  account: { userId: asId("user", "alice"), name: "Alice", email: "alice@example.com" },
  workspace: "/tmp/Parlor/localhost-5301",
  createdAt: 1,
};

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function stubApp(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = request.method === "POST" ? await request.text() : "";
    const entry: Seen = {
      method: request.method,
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
      body: text ? JSON.parse(text) : undefined,
    };
    seen.push(entry);
    return answer(entry);
  };
  return { seen, fetch: fetchStub };
}

const data = (value: unknown) => Response.json({ data: value, tags: [] });

const welcome = {
  id: "h1",
  accepted: true,
  protocol: HOST_PROTOCOL,
  leaseMs: 60_000,
  heartbeatMs: 30_000,
};

function deps(
  fetchStub: typeof fetch,
  overrides: Partial<AppLinkDeps> = {},
): AppLinkDeps {
  return {
    keys: devHostKeys("dev-token"),
    hostVersion: "0.0.0",
    hostName: "Alice's Mac",
    platform: "macos",
    fetch: fetchStub,
    onWake: () => undefined,
    onRevoked: () => undefined,
    onIncompatible: () => undefined,
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("an app link", () => {
  it("T4-01: stops after a refused hostHello, calls onIncompatible once and sends nothing else", async () => {
    const refused = {
      id: "h1",
      accepted: false,
      reason: "host_too_old",
      protocols: { min: 2, max: 2 },
    };
    const app = stubApp(() => data(refused));
    const onIncompatible = vi.fn();
    const link = createAppLink(grant, deps(app.fetch, { onIncompatible }));
    link.start();
    await settle();
    await expect(link.api.calls.call("hostClaim", {})).rejects.toThrow();
    await link.api.heartbeat().catch(() => undefined);
    link.api.stream({
      turnId,
      frames: [
        {
          type: "delta",
          itemId: asId("item", "u1.1"),
          kind: "reply",
          offset: 0,
          text: "x",
        },
      ],
    });
    await settle();

    expect(onIncompatible).toHaveBeenCalledOnce();
    expect(onIncompatible).toHaveBeenCalledWith(grant, refused);
    expect(app.seen.map((seen) => seen.path)).toEqual([
      "/_parlor/chat/actions/hostHello",
    ]);
    expect(link.protocol).toBeUndefined();
  });

  it("says hello first with a fresh credential on every request, then wakes and streams", async () => {
    const app = stubApp((seen) => {
      if (seen.path.endsWith("/hostHello")) return data(welcome);
      if (seen.path.endsWith("/sync/token")) return new Response(null, { status: 503 });
      return data({ id: "t1" });
    });
    const onWake = vi.fn();
    const link = createAppLink(grant, deps(app.fetch, { onWake }));
    link.start();
    await vi.waitFor(() => expect(onWake).toHaveBeenCalled());
    expect(link.protocol).toBe(HOST_PROTOCOL);
    expect(app.seen[0]).toMatchObject({
      path: "/_parlor/chat/actions/hostHello",
      authorization: "ParlorHost dev-token",
      body: {
        protocols: { min: 1, max: HOST_PROTOCOL },
        hostVersion: "0.0.0",
        name: "Alice's Mac",
        platform: "macos",
      },
    });
    for (const seen of app.seen) expect(seen.authorization).toBe("ParlorHost dev-token");
    await link.stop();
  });

  it("keeps one stream post in flight per turn, merges what came meanwhile, and appends after it", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const app = stubApp(async (seen) => {
      if (seen.path.endsWith("/hostHello")) return data(welcome);
      if (seen.path.endsWith("/sync/token")) return new Response(null, { status: 503 });
      if (seen.path.endsWith("/stream")) {
        await held;
        return new Response(null, { status: 204 });
      }
      return data({ id: "t1", leaseUntil: 1, token: { token: "t", expiresAt: 1 } });
    });
    const link = createAppLink(grant, deps(app.fetch));
    link.start();
    const item = asId("item", "u1.1");
    const delta = (offset: number, text: string) =>
      ({ type: "delta", itemId: item, kind: "reply", offset, text }) as const;
    link.api.stream({ turnId, frames: [delta(0, "He")] });
    link.api.stream({ turnId, frames: [delta(2, "ll")] });
    link.api.stream({ turnId, frames: [delta(4, "o")] });
    const appended = link.api.calls.call("hostAppend", {
      turnId,
      items: [{ id: item, kind: "reply", body: { text: "Hello" } }],
    });
    await settle();
    expect(app.seen.filter((seen) => seen.path.endsWith("/hostAppend"))).toEqual([]);
    release();
    await appended;
    const order = app.seen
      .filter(
        (seen) => seen.path.endsWith("/stream") || seen.path.endsWith("/hostAppend"),
      )
      .map((seen) => [seen.path.split("/").at(-1), seen.body]);
    expect(order).toEqual([
      ["stream", { turnId, frames: [delta(0, "He")] }],
      ["stream", { turnId, frames: [delta(2, "llo")] }],
      [
        "hostAppend",
        { turnId, items: [{ id: item, kind: "reply", body: { text: "Hello" } }] },
      ],
    ]);
    await link.stop();
  });

  it("reports the grant revoked on the first 401, once", async () => {
    const app = stubApp((seen) =>
      seen.path.endsWith("/hostHello")
        ? data(welcome)
        : Response.json(
            {
              error: {
                code: "unauthenticated",
                message: "This computer was disconnected.",
              },
            },
            { status: 401 },
          ),
    );
    const onRevoked = vi.fn();
    const link = createAppLink(grant, deps(app.fetch, { onRevoked }));
    link.start();
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalled());
    await link.api.calls.call("hostClaim", {}).catch(() => undefined);
    await settle();
    expect(onRevoked).toHaveBeenCalledOnce();
    expect(onRevoked).toHaveBeenCalledWith(grant);
    await link.stop();
  });

  it("disconnects itself from the app when asked to revoke", async () => {
    const app = stubApp((seen) =>
      seen.path.endsWith("/hostHello")
        ? data(welcome)
        : seen.path === "/_parlor/auth/hosts/revoke"
          ? Response.json({})
          : new Response(null, { status: 503 }),
    );
    const link = createAppLink(grant, deps(app.fetch));
    link.start();
    await vi.waitFor(() => expect(link.protocol).toBe(HOST_PROTOCOL));
    await link.stop({ revoke: true });
    expect(app.seen.at(-1)).toMatchObject({
      method: "POST",
      path: "/_parlor/auth/hosts/revoke",
      authorization: "ParlorHost dev-token",
    });
  });

  it("still revokes from an app it cannot speak to", async () => {
    const app = stubApp((seen) =>
      seen.path.endsWith("/hostHello")
        ? data({
            id: "h1",
            accepted: false,
            reason: "host_too_old",
            protocols: { min: 2, max: 2 },
          })
        : Response.json({}),
    );
    const link = createAppLink(grant, deps(app.fetch));
    link.start();
    await settle();
    await link.stop({ revoke: true });
    expect(app.seen.map((seen) => seen.path)).toEqual([
      "/_parlor/chat/actions/hostHello",
      "/_parlor/auth/hosts/revoke",
    ]);
  });
  it("T6-02: a draining link wakes nobody but keeps its calls and streams for the turns it runs", async () => {
    const app = stubApp((seen) => {
      if (seen.path.endsWith("/hostHello")) return data(welcome);
      if (seen.path.endsWith("/sync/token")) return new Response(null, { status: 503 });
      return data({ id: "t1" });
    });
    const onWake = vi.fn();
    const link = createAppLink(grant, deps(app.fetch, { onWake }));
    expect(link.mode).toBe("idle");
    link.start();
    expect(link.mode).toBe("serving");
    await vi.waitFor(() => expect(onWake).toHaveBeenCalledOnce());
    link.drain();
    expect(link.mode).toBe("draining");
    await link.api.calls.call("hostAppend", { turnId, items: [] });
    await link.api.heartbeat();
    expect(app.seen.map((seen) => seen.path)).toContain(
      "/_parlor/chat/actions/hostAppend",
    );
    expect(onWake).toHaveBeenCalledOnce();
    await link.stop();
    expect(link.mode).toBe("closed");
    link.drain();
    expect(link.mode).toBe("closed");
  });

  it("T6-02: a link drained before its welcome never wakes the host", async () => {
    const app = stubApp((seen) => {
      if (seen.path.endsWith("/hostHello")) return data(welcome);
      if (seen.path.endsWith("/sync/token")) return new Response(null, { status: 503 });
      return data({ id: "t1" });
    });
    const onWake = vi.fn();
    const link = createAppLink(grant, deps(app.fetch, { onWake }));
    link.start();
    link.drain();
    await settle();
    expect(onWake).not.toHaveBeenCalled();
    expect(link.protocol).toBe(HOST_PROTOCOL);
    await link.stop();
  });
});

describe("an app link on a poll deployment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;

  function pollingApp(advertised: boolean) {
    const polls: number[] = [];
    let next: { version: number; id: string; tags: string[][] }[] = [];
    let version = 0;
    const emit = (...tags: string[][]) => {
      version += 1;
      next.push({ version, id: `e${version}`, tags });
    };
    const app = stubApp((seen) => {
      if (seen.path.endsWith("/hostHello")) {
        return data({ ...welcome, ...(advertised ? { userActivity: true } : {}) });
      }
      if (seen.path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "poll",
          endpoint: "",
          pollIntervalMs: 2000,
        });
      }
      if (seen.path.endsWith("/sync")) {
        polls.push(Date.now());
        const events = next;
        next = [];
        const last = events.at(-1);
        return Response.json({
          events,
          cursor: last ? `${last.version}.${last.id}` : "",
        });
      }
      return data({ id: "t1" });
    });
    const gapsWithin = (from: number, to: number) => {
      const within = polls.filter((at) => at >= from && at <= to);
      return within.slice(1).map((at, i) => at - within[i]!);
    };
    return { ...app, polls, emit, gapsWithin };
  }

  const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  const near = (gaps: number[], target: number, tolerance: number) => {
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const gap of gaps) expect(Math.abs(gap - target)).toBeLessThan(tolerance);
  };

  it("T7-02a (a) polls every 15 s when idle, every 2 s once the user is active, and slows again two minutes after the last activity", async () => {
    const app = pollingApp(true);
    const onWake = vi.fn();
    const link = createAppLink(grant, deps(app.fetch, { onWake }));
    link.start();
    await run(1);
    await run(45 * SECOND);
    near(app.gapsWithin(0, Date.now()), 15 * SECOND, SECOND);
    onWake.mockClear();

    app.emit([CHAT_ACTIVITY_TAG]);
    await run(15 * SECOND);
    const seenAt = app.polls.at(-1)!;
    await run(2 * MINUTE - 5 * SECOND);
    near(app.gapsWithin(seenAt + 100, Date.now()), 2 * SECOND, 500);
    expect(onWake).not.toHaveBeenCalled();

    await run(30 * SECOND);
    const slowedFrom = Date.now();
    await run(60 * SECOND);
    near(app.gapsWithin(slowedFrom, Date.now()), 15 * SECOND, SECOND);
    await link.stop();
  });

  it("T7-02a (b) polls again at once when an idle host first sees user activity", async () => {
    const app = pollingApp(true);
    const link = createAppLink(grant, deps(app.fetch));
    link.start();
    await run(1);
    await run(16 * SECOND);
    app.emit([CHAT_ACTIVITY_TAG]);
    await run(15 * SECOND);
    const seenAt = app.polls.at(-1)!;
    await run(1);
    expect(app.polls.at(-1)! - seenAt).toBeLessThan(500);
    await link.stop();
  });

  it("T7-02a (c) claims a prompt that follows activity within 2.5 s of the prompt", async () => {
    const app = pollingApp(true);
    const woken: number[] = [];
    const link = createAppLink(
      grant,
      deps(app.fetch, { onWake: () => woken.push(Date.now()) }),
    );
    link.start();
    await run(1);
    await run(20 * SECOND);
    app.emit([CHAT_ACTIVITY_TAG]);
    await run(15 * SECOND);
    woken.length = 0;

    const sentAt = Date.now();
    app.emit([CHAT_TAG, "t1"]);
    await run(2600);
    expect(woken).toHaveLength(1);
    expect(woken[0]! - sentAt).toBeLessThanOrEqual(2500);
    await link.stop();
  });

  it("T7-02a (d) stays at 2 s while a turn runs, however long ago the user was last active", async () => {
    const app = pollingApp(true);
    let busy = true;
    const link = createAppLink(grant, deps(app.fetch, { busy: () => busy }));
    link.start();
    await run(1);
    await run(5 * MINUTE);
    near(app.gapsWithin(0, Date.now()), 2 * SECOND, 500);

    busy = false;
    await run(3 * SECOND);
    const idleFrom = Date.now();
    await run(60 * SECOND);
    near(app.gapsWithin(idleFrom, Date.now()), 15 * SECOND, SECOND);
    await link.stop();
  });

  it("T7-02a (e) polls every 2 s against a server whose welcome does not advertise user activity", async () => {
    const app = pollingApp(false);
    const link = createAppLink(grant, deps(app.fetch));
    link.start();
    await run(1);
    await run(5 * MINUTE);
    near(app.gapsWithin(0, Date.now()), 2 * SECOND, 500);
    await link.stop();
  });

  it("T7-05 (d) takes an activity event for activity, not for a turn to claim", async () => {
    const app = pollingApp(true);
    const onWake = vi.fn();
    const link = createAppLink(grant, deps(app.fetch, { onWake }));
    link.start();
    await run(1);
    onWake.mockClear();
    app.emit([CHAT_ACTIVITY_TAG]);
    await run(16 * SECOND);
    expect(onWake).not.toHaveBeenCalled();
    const claims = app.seen.filter((seen) => seen.path.endsWith("/hostClaim"));
    expect(claims).toEqual([]);
    await link.stop();
  });
});

describe("an app link's request timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const pathOf = (input: RequestInfo | URL) =>
    new URL(input instanceof Request ? input.url : String(input)).pathname;

  const hangUntilAborted = (input: RequestInfo | URL, init: RequestInit | undefined) =>
    new Promise<Response>((_, reject) =>
      new Request(input, init).signal.addEventListener("abort", () =>
        reject(new Error("aborted")),
      ),
    );

  it("T7-04 (c) fails a chat call whose headers never arrive after 10 s, and keeps the link usable", async () => {
    let hang = false;
    const app = stubApp((seen) =>
      seen.path.endsWith("/hostHello")
        ? data(welcome)
        : seen.path.endsWith("/sync/token")
          ? new Response(null, { status: 503 })
          : data({ id: "t1" }),
    );
    const fetchStub: typeof fetch = (input, init) =>
      hang ? hangUntilAborted(input, init) : app.fetch(input, init);
    const link = createAppLink(grant, deps(fetchStub));
    link.start();
    await vi.advanceTimersByTimeAsync(1);

    hang = true;
    const settled = link.api.calls.call("hostClaim", {}).then(
      () => "answered",
      () => "failed",
    );
    await vi.advanceTimersByTimeAsync(9_900);
    hang = false;
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(200);
    expect(await settled).toBe("failed");
    await expect(link.api.calls.call("hostClaim", {})).resolves.toEqual({ id: "t1" });
    await link.stop();
  });

  it("T7-04 (d) fails a stream post whose headers never arrive, so a turn's append is not held behind it", async () => {
    let hangStream = true;
    const app = stubApp((seen) =>
      seen.path.endsWith("/hostHello")
        ? data(welcome)
        : seen.path.endsWith("/sync/token")
          ? new Response(null, { status: 503 })
          : data({ id: "t1", leaseUntil: 1, token: { token: "t", expiresAt: 1 } }),
    );
    const fetchStub: typeof fetch = (input, init) =>
      hangStream && pathOf(input).endsWith("/stream")
        ? hangUntilAborted(input, init)
        : app.fetch(input, init);
    const link = createAppLink(grant, deps(fetchStub));
    link.start();
    await vi.advanceTimersByTimeAsync(1);

    link.api.stream({
      turnId,
      frames: [
        {
          type: "delta",
          itemId: asId("item", "u1.1"),
          kind: "reply",
          offset: 0,
          text: "x",
        },
      ],
    });
    const appended = link.api.calls.call("hostAppend", { turnId, items: [] });
    await vi.advanceTimersByTimeAsync(10_100);
    hangStream = false;
    await expect(appended).resolves.toMatchObject({ id: "t1" });
    await link.stop();
  });

  it("never times out the sync stream of an SSE deployment", async () => {
    let streams = 0;
    const app = stubApp((seen) => {
      if (seen.path.endsWith("/hostHello")) return data(welcome);
      if (seen.path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      return data({ id: "t1" });
    });
    const fetchStub: typeof fetch = (input, init) => {
      if (pathOf(input).endsWith("/sync/stream")) {
        streams += 1;
        return new Promise<Response>(() => undefined);
      }
      return app.fetch(input, init);
    };
    const link = createAppLink(grant, deps(fetchStub));
    link.start();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(streams).toBe(1);
    await link.stop();
  });
});
