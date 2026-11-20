import { ANONYMOUS, asId, defineAction, type Principal } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import type { HostedSocket, SocketPlatform } from "@parlor/sync/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { AuthFailure, type AuthProvider } from "./auth.js";
import { ANONYMOUS_ACCOUNT, createServer } from "./create-server.js";
import type { PluginHost, ServerPlugin } from "./plugin.js";

const actions = createRegistry({
  addNote: defineAction({
    description: "Add a note.",
    input: z.object({}),
    writes: ["notes"],
    run: () => ({ id: crypto.randomUUID() }),
  }),
});

const people: Record<string, Principal> = {
  alice: { kind: "user", userId: asId("user", "alice"), sessionId: "s-alice" },
  bob: { kind: "user", userId: asId("user", "bob"), sessionId: "s-bob" },
};

const auth = (): AuthProvider => ({
  name: "test-auth",
  setup: () => ({}),
  enforcing: true,
  authenticate: (request) =>
    Promise.resolve(people[request.headers.get("x-test-user") ?? ""] ?? ANONYMOUS),
  challenge: () => new Response(null, { status: 401 }),
  revoked: () => new AbortController().signal,
});

interface Probe {
  readonly hosts: PluginHost[];
  started: number;
  settled: number;
}

function probe(name: string, realtime: boolean, seen: Probe): ServerPlugin {
  return {
    name,
    realtime,
    setup: (host) => {
      seen.hosts.push(host);
      return {
        start: () => void seen.started++,
        settle: async () => void seen.settled++,
        routes: [
          {
            method: "GET",
            path: "/ping",
            access: "public",
            handle: async () => new Response("pong"),
          },
        ],
      };
    },
  };
}

let database: DatabaseHandle;
beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);
afterAll(() => database.close());

function app(seen: Probe = { hosts: [], started: 0, settled: 0 }) {
  let built = 0;
  const options = () => {
    built++;
    return {
      actions,
      database: { ...database, close: undefined },
      auth: auth(),
      plugins: [probe("live", true, seen), probe("probe", false, seen)],
    };
  };
  return { server: createServer(options), seen, built: () => built };
}

const request = (path: string, user?: string, init: RequestInit = {}) =>
  new Request(`http://app.test${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": user } : {}),
      ...(init.headers as object),
    },
  });

const accountKey = (userId: string) =>
  `u${btoa(userId).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;

describe("a split server's edge", { timeout: 30_000 }, () => {
  it("serves actions and plain plugin routes, and sends live connections, the screen, MCP and stateful plugins to the caller's account", async () => {
    const { edge } = app().server.split!();
    const placement = (path: string, user?: string) =>
      edge.placement(request(path, user));

    expect(await placement("/_parlor/actions/addNote", "alice")).toBeUndefined();
    expect(await placement("/_parlor/probe/ping", "alice")).toBeUndefined();
    expect(await placement("/_parlor/manifest", "alice")).toBeUndefined();

    expect(await placement("/_parlor/sync/token", "alice")).toBe(accountKey("alice"));
    expect(await placement("/_parlor/sync/token", "bob")).toBe(accountKey("bob"));
    expect(await placement("/_parlor/ui", "alice")).toBe(accountKey("alice"));
    expect(await placement("/_parlor/mcp", "alice")).toBe(accountKey("alice"));
    expect(await placement("/_parlor/live/ping", "alice")).toBe(accountKey("alice"));
    expect(await placement("/_parlor/sync/token")).toBe(ANONYMOUS_ACCOUNT);

    expect(await placement("/_parlor/sync/socket?ticket=uYWxpY2U.0123abcd")).toBe(
      "uYWxpY2U",
    );
    expect(await placement("/_parlor/sync/socket?ticket=0123abcd")).toBe(
      ANONYMOUS_ACCOUNT,
    );
  });

  it("sends bad credentials to the anonymous account, and refuses to guess when it cannot tell who calls", async () => {
    const failing = (error: Error) =>
      createServer(() => ({
        actions,
        database: { ...database, close: undefined },
        auth: { ...auth(), authenticate: () => Promise.reject(error) },
      })).split!().edge;
    const live = request("/_parlor/sync/token", "alice");
    expect(await failing(new AuthFailure("expired", "Expired.")).placement(live)).toBe(
      ANONYMOUS_ACCOUNT,
    );
    await expect(failing(new Error("database away")).placement(live)).rejects.toThrow(
      "database away",
    );
  });

  it("never starts plugins or listens for notifications, and settles plugins after each request", async () => {
    const { server, seen } = app();
    const { edge } = server.split!();
    const answered = await edge.fetch(
      request("/_parlor/actions/addNote", "alice", { method: "POST", body: "{}" }),
    );
    expect(answered.status).toBe(200);
    const edgeHost = seen.hosts.at(-1)!;
    expect(edgeHost.database?.listen).toBeUndefined();
    expect(edgeHost.database?.notify).toBeTypeOf("function");
    expect(seen.started).toBe(0);
    await edge.settle();
    expect(seen.settled).toBe(2);
  });
});

describe("a split server's accounts", { timeout: 30_000 }, () => {
  it("builds each account from its own call of the options, and starts its plugins", async () => {
    const { server, seen, built } = app();
    const split = server.split!();
    const before = built();
    const alice = split.account(accountKey("alice"));
    const bob = split.account(accountKey("bob"));
    expect(built()).toBe(before + 2);
    const [aliceHost, bobHost] = seen.hosts
      .slice(-4)
      .filter((_, index) => index % 2 === 0);
    expect(aliceHost).not.toBe(bobHost);
    expect(aliceHost!.instances).toBe("one");

    await alice.fetch(request("/_parlor/live/ping", "alice"));
    await bob.fetch(request("/_parlor/live/ping", "bob"));
    expect(seen.started).toBe(4);
  });

  it("is refused for options given as an object, which every account would share", () => {
    const server = createServer({ actions, database: { ...database, close: undefined } });
    expect(() => server.split!().account("anonymous")).toThrow(/createServer\(\(\) =>/);
  });

  it("issues socket tickets that name the account, so the edge can send the socket there", async () => {
    const key = accountKey("alice");
    const account = app().server.split!().account(key);
    const platform: SocketPlatform = {
      accept: () => ({ response: new Response(null), socket: {} as HostedSocket }),
      sockets: () => [],
      wakeAt: () => undefined,
    };
    account.installSockets!(platform);
    const negotiated = (await (
      await account.fetch(
        request("/_parlor/sync/token?transports=ws", "alice", { method: "POST" }),
      )
    ).json()) as { transport: string; ticket: string };
    expect(negotiated.transport).toBe("ws");
    expect(negotiated.ticket.startsWith(`${key}.`)).toBe(true);
    const { edge } = app().server.split!();
    expect(
      await edge.placement(request(`/_parlor/sync/socket?ticket=${negotiated.ticket}`)),
    ).toBe(key);
  });
});
