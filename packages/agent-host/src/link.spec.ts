import { HOST_PROTOCOL } from "@parlor/chat";
import { asId } from "@parlor/core";
import { describe, expect, it, vi } from "vitest";

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
});
